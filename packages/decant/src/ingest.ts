import type { Database } from "bun:sqlite";
import type { Stats } from "node:fs";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { materializeMissingContextWindows } from "./context-window.ts";
import {
  materializeMissingReasoningEfforts,
  resolveSubagentParents,
  seedModelPricing,
} from "./ingest-derive.ts";
import { OpenCodeRun, resolveOpenCodeSpawnLinks, syncOpenCodeSession } from "./ingest-opencode.ts";
import {
  codexTitles,
  discover,
  fileStem,
  geminiProjectPath,
  geminiSessionLayout,
  readClaudeSidecarMeta,
} from "./ingest-scan.ts";
import {
  INGEST_PIPELINE_REVISION,
  type IngestConfig,
  lineCount,
  mtimeSecs,
  type Prepared,
  type SyncProgressListener,
  type SyncReport,
} from "./ingest-shared.ts";
import { writeIngestedFile } from "./ingest-write.ts";
import { getDecantLogger } from "./logging.ts";
import type { ParsedSession } from "./model.ts";
import { materializeMissingModelUsage } from "./model-usage.ts";
import { regenerate as regenerateRecommendations } from "./recommendations.ts";
import { parseClaudeSession } from "./sources/claude.ts";
import { parseCodexSession } from "./sources/codex.ts";
import { parseGeminiSession } from "./sources/gemini.ts";
import { OpenCodeMcpServerNames } from "./sources/opencode-store.ts";
import { queryRow } from "./sqlite-statements.ts";
import { materializeMissingSessionEconomics, refreshSessionCosts } from "./token-economics.ts";
import { resolveWorktreeRoots } from "./worktree.ts";

const logger = getDecantLogger("ingest");

export function sync(
  db: Database,
  config: IngestConfig,
  cancel?: { aborted: boolean },
  onProgress?: SyncProgressListener,
): SyncReport {
  seedModelPricing(db);
  materializeMissingModelUsage(db);
  const repriced = refreshSessionCosts(db);
  const files = discover(config);
  const titles = codexTitles(config);
  const mcpServers = new OpenCodeMcpServerNames({
    globalDir: config.opencodeConfigDir,
    globalFile: config.opencodeConfigPath,
    extraFile: config.opencodeExtraConfigPath,
  });
  const opencode = new OpenCodeRun(db, config.opencodeModelsPath);
  const report: SyncReport = {
    ...(repriced > 0 ? { repriced } : {}),
    scanned: files.length,
    ingested: 0,
    skipped: 0,
    issues: 0,
    issuesByCode: {},
    failed: 0,
    cancelled: false,
  };
  let inspected = 0;
  // A tombstoned file writes no session but can delete lineage descendants and
  // null their parent links, so it counts as a lineage change like an ingest.
  let lineageMayHaveChanged = false;
  const emitProgress = (): void =>
    onProgress?.({
      scanned: inspected,
      ingested: report.ingested,
      skipped: report.skipped,
      failed: report.failed,
      total: files.length,
    });

  emitProgress();

  try {
    for (const file of files) {
      if (cancel?.aborted === true) {
        report.cancelled = true;
        break;
      }

      try {
        if (file.opencode != null) {
          // Virtual `<db>#<session>` paths never exist on disk; the file-open
          // path below would silently skip them as ENOENT.
          const outcome = syncOpenCodeSession(db, file, file.opencode, opencode, mcpServers);
          if (outcome.kind === "ingested") {
            report.ingested += 1;
            report.issues += outcome.issues.length;
            for (const issue of outcome.issues) {
              report.issuesByCode[issue.code] = (report.issuesByCode[issue.code] ?? 0) + 1;
            }
          } else if (outcome.kind === "failed") {
            report.failed += 1;
          } else {
            report.skipped += 1;
            lineageMayHaveChanged ||= outcome.kind === "tombstoned";
          }
          continue;
        }
        // One descriptor for everything: the skip decision, the recorded stat,
        // and the content read all describe the same inode, so a path swapped
        // mid-loop can neither skip wrongly nor record metadata for content that
        // was never read. A file that vanished before open is a silent skip,
        // matching the old stat-failure path; any other open error counts as
        // failed, matching the old read-failure path.
        let fd: number;
        try {
          fd = openSync(file.path, "r");
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") {
            report.failed += 1;
          }
          continue;
        }
        let stats: Stats;
        let content: string;
        try {
          stats = fstatSync(fd);
          const prior = queryRow<{ size: number; mtime: number; ingest_revision: number }>(
            db,
            "SELECT size, mtime, ingest_revision FROM ingest_source WHERE path = ?1",
            [file.path],
          );
          if (
            prior != null &&
            prior.size === stats.size &&
            prior.mtime === mtimeSecs(stats) &&
            prior.ingest_revision === INGEST_PIPELINE_REVISION
          ) {
            report.skipped += 1;
            continue;
          }
          // fstat before read: a write landing mid-window records a smaller size
          // than the content read, so the next sync re-ingests instead of
          // silently skipping the tail.
          content = readFileSync(fd, "utf8");
        } catch (error) {
          report.failed += 1;
          logger.warning("Source file could not be read.", {
            "event.name": "decant.ingest.source_read_failed",
            "file.path": file.path,
            "error.type": (error as { code?: string }).code ?? "unknown",
            "error.message": error instanceof Error ? error.message : String(error),
          });
          continue;
        } finally {
          try {
            closeSync(fd);
          } catch {
            // A close failure (EIO on network/FUSE mounts) cannot invalidate a
            // read that already succeeded, and a throw here would mask the real
            // error on the failure path.
          }
        }

        const stem = fileStem(file.path);
        let parsed: ParsedSession;
        if (file.tool === "claude_code") {
          parsed = parseClaudeSession(stem, content, {
            sourcePath: file.path,
            sidecarMeta: readClaudeSidecarMeta(file.path),
          });
        } else if (file.tool === "gemini") {
          const layout = geminiSessionLayout(file.path);
          parsed = parseGeminiSession(stem, content, geminiProjectPath(layout), {
            parentSessionId: layout?.parentSessionId ?? null,
          });
        } else {
          parsed = parseCodexSession(stem, content, titles);
        }
        parsed.session.isArchived = file.archived;

        const prepared: Prepared = {
          file,
          lineCount: lineCount(content),
          mtime: mtimeSecs(stats),
          size: stats.size,
        };

        const outcome = writeIngestedFile(db, prepared, parsed);
        if (outcome === "tombstoned") {
          report.skipped += 1;
          lineageMayHaveChanged = true;
        } else {
          report.ingested += 1;
          report.issues += parsed.issues.length;
          for (const issue of parsed.issues) {
            report.issuesByCode[issue.code] = (report.issuesByCode[issue.code] ?? 0) + 1;
          }
        }
      } finally {
        inspected += 1;
        emitProgress();
      }
    }
  } finally {
    opencode.close();
  }

  refreshDerivedState(db, report, repriced, lineageMayHaveChanged);

  return report;
}

/** Work that follows the ingest loop, each step gated on the change that can invalidate it. */
function refreshDerivedState(
  db: Database,
  report: SyncReport,
  repriced: number,
  lineageMayHaveChanged: boolean,
): void {
  // Lineage depends only on session rows and blocks, which change only through
  // ingest. An unchanged archive keeps the links the last ingest resolved, so
  // skipping here saves an O(archive) pass on every watcher sweep. A change to
  // the inference rules must bump INGEST_PIPELINE_REVISION to re-ingest.
  if (report.ingested > 0 || lineageMayHaveChanged) {
    resolveOpenCodeSpawnLinks(db);
    resolveSubagentParents(db);
  }
  const materializedEconomics = materializeMissingSessionEconomics(db);
  const materializedWindows = materializeMissingContextWindows(db);
  const materializedEfforts = materializeMissingReasoningEfforts(db);
  if (report.ingested > 0) {
    resolveWorktreeRoots(db);
  }
  const uncheckedRecommendationImpactLabels =
    db
      .query(
        `SELECT 1
           FROM recommendation
          WHERE kind = 'signal' AND impact_label_checked = 0
          LIMIT 1`,
      )
      .get() != null;
  if (report.ingested > 0 || repriced > 0 || uncheckedRecommendationImpactLabels) {
    regenerateRecommendations(db);
  }
  if (
    report.ingested > 0 ||
    materializedEconomics > 0 ||
    materializedWindows > 0 ||
    materializedEfforts > 0
  ) {
    // Refresh planner statistics after write bursts; without ANALYZE data the
    // query planner picks pathological join orders on multi-GB archives.
    db.exec("PRAGMA optimize;");
  }
}

export {
  materializeMissingReasoningEfforts,
  resolveSubagentParents,
  seedModelPricing,
} from "./ingest-derive.ts";
export {
  isOpenCodeDatabaseName,
  openCodeChangeKey,
  openCodeSourcePath,
} from "./ingest-opencode.ts";
export { discover, discoverSourcePaths } from "./ingest-scan.ts";
export type {
  IngestConfig,
  SourceFile,
  SyncProgress,
  SyncProgressListener,
  SyncReport,
} from "./ingest-shared.ts";
export { INGEST_PIPELINE_REVISION, lineCount } from "./ingest-shared.ts";
export { upsertSession } from "./ingest-write.ts";
