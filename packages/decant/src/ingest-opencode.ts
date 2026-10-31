import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  INGEST_PIPELINE_REVISION,
  type IngestConfig,
  type Prepared,
  type SourceFile,
} from "./ingest-shared.ts";
import { writeIngestedFile } from "./ingest-write.ts";
import { getDecantLogger } from "./logging.ts";
import type { Issue } from "./model.ts";
import { compareCodePoints } from "./order.ts";
import { parseOpenCodeSession } from "./sources/opencode.ts";
import { parseOpenCodeLegacySession } from "./sources/opencode-legacy.ts";
import {
  type OpenCodeLegacyLoadedSession,
  type OpenCodeLoadedSession,
  type OpenCodeMcpServerNames,
  type OpenCodeSessionRef,
  OpenCodeStore,
  readOpenCodeModelsCache,
} from "./sources/opencode-store.ts";
import { queryRow, queryRows, runStatement } from "./sqlite-statements.ts";

const logger = getDecantLogger("ingest");
/** `opencode.db` and channel variants under the data directory, plus the
 * explicit `OPENCODE_DB` file. The `-wal`/`-shm` sidecars never match. */
export function openCodeDatabasePaths(config: IngestConfig): string[] {
  const paths: string[] = [];
  if (config.opencodeDir != null && existsSync(config.opencodeDir)) {
    let entries: string[];
    try {
      entries = readdirSync(config.opencodeDir);
    } catch {
      entries = [];
    }
    for (const name of entries.sort(compareCodePoints)) {
      if (isOpenCodeDatabaseName(name)) {
        paths.push(join(config.opencodeDir, name));
      }
    }
  }
  if (config.opencodeDb != null && config.opencodeDb !== "" && !paths.includes(config.opencodeDb)) {
    paths.push(config.opencodeDb);
  }
  return paths;
}

const OPENCODE_DATABASE_NAME = /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/;

export function isOpenCodeDatabaseName(name: string): boolean {
  return OPENCODE_DATABASE_NAME.test(name);
}

export function openCodeSourcePath(ref: OpenCodeSessionRef): string {
  return `${ref.dbPath}#${ref.sessionId}`;
}

/** One virtual source per session, from either the 2.x tables or the 1.x
 * tables. A session present in several places (a channel build beside the
 * stable one, or both formats of one database once 2.x migrated it while a 1.x
 * binary still writes it) is read from the copy OpenCode updated last; see
 * `isNewerOpenCodeCopy`. Databases that cannot be opened are skipped. */
export function discoverOpenCode(dbPaths: string[]): SourceFile[] {
  const best = new Map<string, OpenCodeSessionRef>();
  // One database reached through a symlink, a relative path, or both the data
  // directory and OPENCODE_DB is opened once and names one virtual path.
  for (const dbPath of new Set(dbPaths.map(canonicalPath))) {
    if (!existsSync(dbPath)) {
      continue;
    }
    let store: OpenCodeStore;
    try {
      store = OpenCodeStore.open(dbPath);
    } catch (error) {
      logger.warning("OpenCode database could not be opened.", {
        "event.name": "decant.ingest.opencode_open_failed",
        "file.path": dbPath,
        "error.message": error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      if (store.isPreSplitDatabase()) {
        // Its `session` rows are 2.x-shaped, so the 1.x reader would misread
        // them; OpenCode converts the file the next time a 2.x release opens it.
        logger.warning("OpenCode database uses a pre-release layout and was skipped.", {
          "event.name": "decant.ingest.opencode_unsupported_layout",
          "file.path": dbPath,
        });
        continue;
      }
      const keepNewest = (ref: OpenCodeSessionRef): void => {
        const prior = best.get(ref.sessionId);
        if (prior == null || isNewerOpenCodeCopy(ref, prior)) {
          best.set(ref.sessionId, ref);
        }
      };
      // A failed 1.x listing still leaves this database's 2.x sessions
      // discovered, keyed without their 1.x copies.
      let legacy: OpenCodeSessionRef[] = [];
      let legacyError: unknown = null;
      try {
        legacy = store.listLegacySessions();
      } catch (error) {
        legacyError = error;
      }
      store.listSessions(legacy).forEach(keepNewest);
      legacy.forEach(keepNewest);
      if (legacyError != null) {
        throw legacyError;
      }
    } catch (error) {
      logger.warning("OpenCode database could not be listed.", {
        "event.name": "decant.ingest.opencode_list_failed",
        "file.path": dbPath,
        "error.message": error instanceof Error ? error.message : String(error),
      });
    } finally {
      store.close();
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        compareCodePoints(a.dbPath, b.dbPath) || compareCodePoints(a.sessionId, b.sessionId),
    )
    .map((ref) => ({
      tool: "opencode" as const,
      path: openCodeSourcePath(ref),
      archived: false,
      opencode: ref,
    }));
}

/** Newest `time_updated` wins, across formats as well as databases: a 1.x
 * binary can keep writing a session after a 2.x build migrated it. A tie in
 * one database goes to the 2.x copy, because the migrator copies
 * `time_updated` verbatim, so a tie is the usual state of a migrated session.
 * A tie across databases goes to the code-point-smaller path. Either way the
 * winner never depends on discovery order. */
function isNewerOpenCodeCopy(ref: OpenCodeSessionRef, prior: OpenCodeSessionRef): boolean {
  if (ref.timeUpdated !== prior.timeUpdated) {
    return ref.timeUpdated > prior.timeUpdated;
  }
  if (ref.dbPath === prior.dbPath) {
    return ref.format === "v2" && prior.format === "v1";
  }
  return compareCodePoints(ref.dbPath, prior.dbPath) < 0;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

type OpenCodeSyncOutcome =
  | { kind: "skipped" | "tombstoned" | "failed" }
  | { kind: "ingested"; issues: Issue[] };

/** Appended to a session's change key in `ingest_source.hash` when it was
 * derived without its database's model catalog, so a later sync that can read
 * the catalog re-derives it once instead of skipping it on an unchanged key. */
const WITHOUT_CATALOG = "|no-catalog";

/** A session's change key: its database fingerprint plus, when any MCP server
 * applies to it, a digest of those server names. MCP names decide how its
 * tool calls are classified, so a config edit that changes the set for its
 * directory re-derives the session once; other sessions keep their key. */
export function openCodeChangeKey(fingerprint: string, mcpServers: readonly string[]): string {
  if (mcpServers.length === 0) {
    return fingerprint;
  }
  const digest = createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex");
  return `${fingerprint}|mcp:${digest.slice(0, 12)}`;
}

/** A database's models.dev context windows, or an empty map when the catalog
 * read failed. */
interface OpenCodeCatalog {
  windows: ReadonlyMap<string, number>;
  available: boolean;
}

/**
 * OpenCode state for one sync: one read-only connection and one catalog read
 * per database, and the database halves of the `<db>#<session>` paths already
 * in `ingest_source`. Connections are closed after the loop whether or not it
 * finished.
 */
export class OpenCodeRun {
  readonly #db: Database;
  readonly #modelsPath: string | null;
  readonly #stores = new Map<string, OpenCodeStore>();
  readonly #catalogs = new Map<string, OpenCodeCatalog>();
  #modelsCache: OpenCodeCatalog | null = null;
  #sourceDatabases: Set<string> | null = null;

  constructor(db: Database, modelsPath: string | undefined) {
    this.#db = db;
    this.#modelsPath = modelsPath == null || modelsPath === "" ? null : modelsPath;
  }

  store(dbPath: string): OpenCodeStore | null {
    let store = this.#stores.get(dbPath);
    if (store == null) {
      try {
        store = OpenCodeStore.open(dbPath);
      } catch (error) {
        logger.warning("OpenCode database could not be opened.", {
          "event.name": "decant.ingest.opencode_open_failed",
          "file.path": dbPath,
          "error.message": error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      this.#stores.set(dbPath, store);
    }
    return store;
  }

  /** Read once per database per sync. A failure warns once for the database
   * and yields an empty catalog: sessions still ingest, without context
   * windows, rather than each failing and warning on every sync. */
  catalog(store: OpenCodeStore): OpenCodeCatalog {
    let catalog = this.#catalogs.get(store.path);
    if (catalog == null) {
      try {
        catalog = { windows: store.contextWindows(), available: true };
        if (catalog.windows.size === 0 && this.#modelsPath != null) {
          // OpenCode 1.x keeps the catalog in a cache file, not the database.
          catalog = this.#readModelsCache(this.#modelsPath);
        }
      } catch (error) {
        logger.warning("OpenCode model catalog could not be read.", {
          "event.name": "decant.ingest.opencode_catalog_failed",
          "file.path": store.path,
          "error.message": error instanceof Error ? error.message : String(error),
        });
        catalog = { windows: new Map(), available: false };
      }
      this.#catalogs.set(store.path, catalog);
    }
    return catalog;
  }

  /** Read once per sync, whichever databases need it. Without the file the
   * catalog counts as unavailable, so sessions derived without it are
   * re-derived once it can be read. */
  #readModelsCache(path: string): OpenCodeCatalog {
    if (this.#modelsCache == null) {
      const cache = readOpenCodeModelsCache(path);
      if (cache.status === "ok") {
        this.#modelsCache = { windows: cache.windows, available: true };
      } else {
        if (cache.status === "missing") {
          logger.info("OpenCode model cache was not found; context windows stay unknown.", {
            "event.name": "decant.ingest.opencode_models_cache_missing",
            "file.path": path,
          });
        } else {
          logger.warning("OpenCode model cache could not be read.", {
            "event.name": "decant.ingest.opencode_models_cache_failed",
            "file.path": path,
            "error.message": cache.error,
          });
        }
        this.#modelsCache = { windows: new Map(), available: false };
      }
    }
    return this.#modelsCache;
  }

  /** Every `<db>` with an OpenCode source row, read on first use and then
   * extended by each session this sync writes. */
  sourceDatabases(): Set<string> {
    if (this.#sourceDatabases == null) {
      // rtrim with every non-'#' character of the path strips back to its last
      // '#', the separator before the session ID.
      this.#sourceDatabases = new Set(
        queryRows<{ prefix: string }>(
          this.#db,
          `SELECT DISTINCT rtrim(path, replace(path, '#', '')) AS prefix
             FROM ingest_source
            WHERE tool = 'opencode' AND instr(path, '#') > 0`,
        ).map((row) => row.prefix.slice(0, -1)),
      );
    }
    return this.#sourceDatabases;
  }

  close(): void {
    for (const store of this.#stores.values()) {
      store.close();
    }
    this.#stores.clear();
  }
}

/** Skip when the stored change key and pipeline revision match; otherwise
 * read, parse, and write the session under its virtual path. A session last
 * derived without the model catalog stays skipped until the catalog reads. */
export function syncOpenCodeSession(
  db: Database,
  file: SourceFile,
  ref: OpenCodeSessionRef,
  opencode: OpenCodeRun,
  mcpServers: OpenCodeMcpServerNames,
): OpenCodeSyncOutcome {
  const prior = queryRow<{ hash: string | null; ingest_revision: number }>(
    db,
    "SELECT hash, ingest_revision FROM ingest_source WHERE path = ?1",
    [file.path],
  );
  const current = prior != null && prior.ingest_revision === INGEST_PIPELINE_REVISION;
  const mcpServerNames = mcpServers.forDirectory(ref.directory);
  const changeKey = openCodeChangeKey(ref.fingerprint, mcpServerNames);
  if (current && prior.hash === changeKey) {
    return { kind: "skipped" };
  }
  const store = opencode.store(ref.dbPath);
  if (store == null) {
    return { kind: "failed" };
  }
  if (
    current &&
    prior.hash === `${changeKey}${WITHOUT_CATALOG}` &&
    !opencode.catalog(store).available
  ) {
    return { kind: "skipped" };
  }
  const loaded = readOpenCodeSession(store, ref, file.path);
  if (loaded === "failed") {
    return { kind: "failed" };
  }
  if (loaded == null) {
    // Deleted between discovery and read. Nothing is written or removed: a
    // session deleted from opencode.db simply stops being discovered, and the
    // archive keeps the copy it last ingested.
    return { kind: "skipped" };
  }
  const catalog = opencode.catalog(store);
  // The names behind the change key, so the stored key matches what the
  // session was derived with.
  const context = { mcpServers: mcpServerNames, contextWindows: catalog.windows };
  const parsed =
    loaded.format === "v1"
      ? parseOpenCodeLegacySession(loaded.session, loaded.messages, loaded.parts, context)
      : parseOpenCodeSession(loaded.session, loaded.messages, context, loaded.legacy);
  const prepared: Prepared = {
    file,
    lineCount: loaded.messages.length,
    mtime: Math.trunc(loaded.session.time_updated / 1000),
    size: 0,
    hash: catalog.available ? changeKey : `${changeKey}${WITHOUT_CATALOG}`,
  };
  const outcome = writeIngestedFile(db, prepared, parsed, opencode);
  return outcome === "tombstoned"
    ? { kind: "tombstoned" }
    : { kind: "ingested", issues: parsed.issues };
}

type OpenCodeLoaded =
  | ({ format: "v2" } & OpenCodeLoadedSession)
  | ({ format: "v1" } & OpenCodeLegacyLoadedSession);

/** Reads the session from the tables its ref names. A failed read fails the
 * one session rather than the whole sync. It writes no `ingest_source` row, so
 * the next sync retries it. */
function readOpenCodeSession(
  store: OpenCodeStore,
  ref: OpenCodeSessionRef,
  sourcePath: string,
): OpenCodeLoaded | null | "failed" {
  try {
    if (ref.format === "v1") {
      const loaded = store.loadLegacySession(ref.sessionId);
      return loaded == null ? null : { format: "v1", ...loaded };
    }
    const loaded = store.loadSession(ref.sessionId);
    return loaded == null ? null : { format: "v2", ...loaded };
  } catch (error) {
    logger.warning("Source file could not be read.", {
      "event.name": "decant.ingest.source_read_failed",
      "file.path": sourcePath,
      "error.type": "opencode_read",
      "error.message": error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/** OpenCode names a child session only inside the parent's spawn tool
 * result, so the child's spawn link is resolved once both sides are stored,
 * before lineage resolution reads it. 2.x writes `subagent` with
 * `state.metadata.sessionID`; 1.x, and 2.x rows the migrator copied from 1.x
 * (it never renames them in data), write `task` with `state.metadata.sessionId`.
 * A 1.x result's `raw` is the tool part, whose `id` is the part id and whose
 * `callID` is the call; a 2.x result's `id` is the call. */
export function resolveOpenCodeSpawnLinks(db: Database): void {
  runStatement(
    db,
    `UPDATE session
        SET spawn_tool_use_id = (
          SELECT COALESCE(json_extract(m.raw, '$.callID'), json_extract(m.raw, '$.id'))
            FROM message m
            JOIN session parent ON parent.id = m.session_id
           WHERE parent.tool = 'opencode'
             AND parent.source_session_id = json_extract(session.raw_meta, '$.parentSessionId')
             AND m.role = 'tool'
             AND json_valid(m.raw)
             AND ((json_extract(m.raw, '$.name') = 'subagent'
                   AND json_extract(m.raw, '$.state.metadata.sessionID') = session.source_session_id)
               OR (COALESCE(json_extract(m.raw, '$.tool'), json_extract(m.raw, '$.name')) = 'task'
                   AND json_extract(m.raw, '$.state.metadata.sessionId') = session.source_session_id))
           ORDER BY m.id
           LIMIT 1)
      WHERE tool = 'opencode'
        AND is_subagent = 1
        AND spawn_tool_use_id IS NULL
        AND raw_meta IS NOT NULL
        AND json_valid(raw_meta)`,
  );
}
