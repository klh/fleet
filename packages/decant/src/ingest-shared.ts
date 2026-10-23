import type { Stats } from "node:fs";
import type { IngestIssueCode, Json, NormalizedBlock, Tool } from "./model.ts";
import type { OpenCodeSessionRef } from "./sources/opencode-store.ts";

export interface IngestConfig {
  claudeDir: string;
  codexDir: string;
  geminiDir?: string;
  /** OpenCode data directory holding `opencode.db` and `opencode-<channel>.db`. */
  opencodeDir?: string;
  /** Explicit OpenCode database file (`OPENCODE_DB`), read in addition to `opencodeDir`. */
  opencodeDb?: string;
  /** OpenCode's global config directory; its `opencode.json` and
   * `opencode.jsonc` name MCP servers, as do each session's project configs. */
  opencodeConfigDir?: string;
  /** Read in place of the global directory's files (`DECANT_OPENCODE_CONFIG`). */
  opencodeConfigPath?: string;
  /** Read in addition to the global and project configs (`OPENCODE_CONFIG`). */
  opencodeExtraConfigPath?: string;
  /** OpenCode 1.x's models.dev cache file, read for context windows when a
   * database holds no catalog (a database only 1.x opened). */
  opencodeModelsPath?: string;
  sourcePaths?: string[];
}

/**
 * Version of the source-to-archive derivation pipeline. Increment this when a
 * parser or ingest enrichment change must be applied to already-seen source
 * files. The next sync re-ingests each stale source transactionally once.
 */
export const INGEST_PIPELINE_REVISION = 12;

export interface SyncReport {
  /** Present when stored cost estimates changed without requiring re-ingest. */
  repriced?: number;
  scanned: number;
  ingested: number;
  skipped: number;
  issues: number;
  /** `issues` split by IngestIssueCode; only codes actually seen appear. Lets
   * callers separate data loss (`unparsed_line`) from informational sensors. */
  issuesByCode: Partial<Record<IngestIssueCode, number>>;
  failed: number;
  cancelled: boolean;
}

/** A snapshot of a running sync. `scanned` is the number of discovered source
 * files inspected so far; `total` is the number discovered at startup. */
export interface SyncProgress {
  scanned: number;
  ingested: number;
  skipped: number;
  failed: number;
  total: number;
}

export type SyncProgressListener = (progress: SyncProgress) => void;

export interface SourceFile {
  tool: Tool;
  path: string;
  archived: boolean;
  /** Set for OpenCode sessions, whose `path` is the virtual `<db>#<session id>`. */
  opencode?: OpenCodeSessionRef;
}

export interface Prepared {
  file: SourceFile;
  lineCount: number;
  mtime: number;
  size: number;
  /** Per-session change key for database-backed sources; JSONL sources keep NULL. */
  hash?: string | null;
}

export interface ToolUseBlock {
  messageId: number;
  callBlockId: number;
  timestamp: string | null;
  block: NormalizedBlock;
}

/** Lines as `split(/\r?\n/)` counts them after dropping one trailing newline. */
export function lineCount(content: string): number {
  if (content === "") {
    return 0;
  }
  let newlines = 0;
  for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) {
    newlines += 1;
  }
  return content.endsWith("\n") ? newlines : newlines + 1;
}

export function mtimeSecs(stats: Stats): number {
  return Math.trunc(stats.mtimeMs / 1000);
}

export function durationBetween(start: string | null, end: string | null): number | null {
  if (start == null || end == null) {
    return null;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  return endMs - startMs;
}

/** Multi-path json_extract keeps JSON types, so `true` stays distinct from `1`. */
export function firstMessageFields(value: string | null): Json | undefined {
  const fields = parseObject(value);
  if (!Array.isArray(fields)) {
    return undefined;
  }
  return {
    isSidechain: fields[0] ?? null,
    sessionId: fields[1] ?? null,
    agentId: fields[2] ?? null,
  };
}

export function parseObject(value: string | null): Json | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as Json;
  } catch {
    return undefined;
  }
}
