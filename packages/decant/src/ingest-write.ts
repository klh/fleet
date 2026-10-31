import type { Database } from "bun:sqlite";
import { outcome, workType } from "./classify.ts";
import { materializeContextWindow } from "./context-window.ts";
import { withImmediateTransaction } from "./db.ts";
import { facets, fileRefs } from "./enrich.ts";
import type { OpenCodeRun } from "./ingest-opencode.ts";
import {
  durationBetween,
  INGEST_PIPELINE_REVISION,
  type Prepared,
  type ToolUseBlock,
} from "./ingest-shared.ts";
import { byteLength, canonicalJson } from "./json.ts";
import type { ParsedSession } from "./model.ts";
import { materializeModelUsage, sessionCostParts, totalCost } from "./model-usage.ts";
import { inheritDeletedSessionTombstone } from "./session-user-state.ts";
import { queryRow, runStatement } from "./sqlite-statements.ts";
import { materializeSessionEconomics } from "./token-economics.ts";
import { classifyTool, previewHeadTail } from "./tools.ts";
import { basename } from "./worktree.ts";

/**
 * Insert or replace one parsed session. Returns 0 when the source identity or
 * its provider-recorded parent has a durable deleted tombstone, leaving the
 * archive unchanged and extending that tombstone through the lineage.
 */
export function upsertSession(
  db: Database,
  parsed: ParsedSession,
  sourcePath: string,
  mtime: number,
  size: number,
  hash: string | null = null,
): number {
  return (
    withImmediateTransaction(db, () => writeSession(db, parsed, sourcePath, mtime, size, hash)) ?? 0
  );
}

export function writeIngestedFile(
  db: Database,
  prepared: Prepared,
  parsed: ParsedSession,
  opencode?: OpenCodeRun,
): "ingested" | "tombstoned" {
  return withImmediateTransaction(db, () => {
    releaseMisfiledFork(db, prepared.file.path, parsed);
    const ref = prepared.file.opencode;
    if (ref != null && opencode != null) {
      const databases = opencode.sourceDatabases();
      releaseSupersededOpenCodeSources(db, prepared.file.path, ref.sessionId, databases);
      databases.add(ref.dbPath);
    }
    runStatement(db, "UPDATE ingest_source SET session_id = NULL WHERE path = ?1", [
      prepared.file.path,
    ]);
    const sessionId = writeSession(
      db,
      parsed,
      prepared.file.path,
      prepared.mtime,
      prepared.size,
      prepared.hash ?? null,
    );
    if (sessionId == null) {
      runStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [prepared.file.path]);
      writeIngestSource(db, prepared, null, "skipped_deleted");
      return "tombstoned";
    }
    runStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [prepared.file.path]);
    const insertIssue = db.prepare(
      `INSERT INTO ingest_issue(source_path, line_no, error, raw_line, code, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
    );
    try {
      for (const issue of parsed.issues) {
        insertIssue.run(prepared.file.path, issue.lineNo, issue.error, issue.rawLine, issue.code);
      }
    } finally {
      insertIssue.finalize();
    }
    const status = parsed.issues.length === 0 ? "ok" : "ok_with_issues";
    writeIngestSource(db, prepared, sessionId, status);
    return "ingested";
  });
}

/** Earlier parsers filed a forked Codex subagent under the thread it forked
 * from. Re-reading the fork removes that row, because the parent's own rollout
 * may be gone and nothing else would ever replace it. */
function releaseMisfiledFork(db: Database, path: string, parsed: ParsedSession): void {
  const parent = parsed.session.rootSourceSessionId;
  if (parsed.session.tool !== "codex" || parent == null) {
    return;
  }
  const misfiled = queryRow<{ id: number }>(
    db,
    "SELECT id FROM session WHERE tool = 'codex' AND source_session_id = ?1 AND source_path = ?2",
    [parent, path],
  );
  if (misfiled != null) {
    deleteSessionRow(db, misfiled.id);
  }
}

/** A session read from a newer copy in another database no longer belongs to
 * the old `<db>#<session>` path. Its source and issue rows go, so diagnostics
 * stop naming a path that backs nothing, and so the old copy is re-read rather
 * than skipped on a stale fingerprint if the newer database later disappears.
 * The candidates are one primary-key lookup per known database, not a scan of
 * every OpenCode source on each session write. */
function releaseSupersededOpenCodeSources(
  db: Database,
  path: string,
  sessionId: string,
  databases: ReadonlySet<string>,
): void {
  // The session ID follows the path's last '#', so an ID containing one never
  // names a source.
  if (sessionId.includes("#")) {
    return;
  }
  for (const database of databases) {
    const candidate = `${database}#${sessionId}`;
    if (
      candidate === path ||
      queryRow(db, "SELECT 1 FROM ingest_source WHERE path = ?1 AND tool = 'opencode'", [
        candidate,
      ]) == null
    ) {
      continue;
    }
    runStatement(db, "DELETE FROM ingest_issue WHERE source_path = ?1", [candidate]);
    runStatement(db, "DELETE FROM ingest_source WHERE path = ?1", [candidate]);
  }
}

function deleteSessionRow(db: Database, id: number): void {
  runStatement(db, "UPDATE session SET parent_session_id = NULL WHERE parent_session_id = ?1", [
    id,
  ]);
  runStatement(db, "DELETE FROM session WHERE id = ?1", [id]);
}

function writeIngestSource(
  db: Database,
  prepared: Prepared,
  sessionId: number | null,
  status: "ok" | "ok_with_issues" | "skipped_deleted",
): void {
  runStatement(
    db,
    `INSERT INTO ingest_source(
       path, tool, size, mtime, ingest_revision, session_id, line_count, status,
       last_ingested_at, hash
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), ?9)
     ON CONFLICT(path) DO UPDATE SET
       tool = ?2, size = ?3, mtime = ?4, hash = ?9, ingest_revision = ?5,
       session_id = ?6, line_count = ?7, status = ?8, error = NULL,
       last_ingested_at = datetime('now')`,
    [
      prepared.file.path,
      prepared.file.tool,
      prepared.size,
      prepared.mtime,
      INGEST_PIPELINE_REVISION,
      sessionId,
      prepared.lineCount,
      status,
      prepared.hash ?? null,
    ],
  );
}

function writeSession(
  db: Database,
  parsed: ParsedSession,
  sourcePath: string,
  mtime: number,
  size: number,
  hash: string | null = null,
): number | null {
  const s = parsed.session;
  if (
    inheritDeletedSessionTombstone(
      db,
      s.tool,
      s.sourceSessionId,
      s.isSubagent ? s.rootSourceSessionId : null,
      {
        rootSourceSessionId: s.rootSourceSessionId,
        spawnToolUseId: s.spawnToolUseId,
        ownedSpawnToolUseIds: claudeSpawnToolUseIds(parsed),
      },
    )
  ) {
    return null;
  }
  let projectId: number | null = null;
  if (s.projectPath != null) {
    runStatement(
      db,
      `INSERT INTO project(path, name, first_seen_at, last_seen_at)
       VALUES (?1, ?2, datetime('now'), datetime('now'))
       ON CONFLICT(path) DO UPDATE SET last_seen_at = datetime('now')`,
      [s.projectPath, basename(s.projectPath)],
    );
    projectId =
      queryRow<{ id: number }>(db, "SELECT id FROM project WHERE path = ?1", [s.projectPath])?.id ??
      null;
  }

  const existing = queryRow<{ id: number }>(
    db,
    "SELECT id FROM session WHERE tool = ?1 AND source_session_id = ?2",
    [s.tool, s.sourceSessionId],
  );
  if (existing != null) {
    deleteSessionRow(db, existing.id);
  }

  const refs = fileRefs(s);
  const gotFacets = facets(s);
  const gotOutcome = outcome(s);
  const gotWorkType = workType(s, refs);

  const sessionId = runStatement(
    db,
    `INSERT INTO session(
       tool, source_session_id, project_id, title, cwd, git_branch, model, cli_version,
       started_at, ended_at, message_count,
       total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens,
       total_reasoning_tokens,
       estimated_cost_usd, is_archived,
       is_subagent, parent_session_id, spawn_tool_use_id, agent_id, agent_type, spawn_depth,
       source_path, raw_meta,
       ingested_at, source_mtime, source_size, source_hash,
       turn_count, error_count, interruption_count, compaction_count, sidechain_message_count,
       agent_spawn_count, skill_count, command_count, thinking_block_count, thinking_chars,
       active_seconds, outcome, work_type,
       est_reasoning_tokens, reasoning_source,
       id,
       total_cache_creation_1h_tokens,
       reasoning_effort, reasoning_effort_levels, reasoning_effort_checked
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, datetime('now'), ?27, ?28, ?29, ?30, ?31,
             ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42, ?43, ?44, ?45, ?46, ?47, ?48, 1)`,
    [
      s.tool,
      s.sourceSessionId,
      projectId,
      s.title,
      s.cwd,
      s.gitBranch,
      s.model,
      s.cliVersion,
      s.startedAt,
      s.endedAt,
      s.messages.length,
      s.totals.input,
      s.totals.output,
      s.totals.cacheRead,
      s.totals.cacheCreation,
      s.totals.reasoning,
      // Priced below from per-request usage once the messages are stored.
      0,
      Number(s.isArchived),
      Number(s.isSubagent),
      null,
      s.spawnToolUseId,
      s.agentId,
      s.agentType,
      s.spawnDepth,
      sourcePath,
      canonicalJson(s.rawMeta),
      mtime,
      size,
      hash,
      gotFacets.turnCount,
      gotFacets.errorCount,
      gotFacets.interruptionCount,
      gotFacets.compactionCount,
      gotFacets.sidechainMessageCount,
      gotFacets.agentSpawnCount,
      gotFacets.skillCount,
      gotFacets.commandCount,
      gotFacets.thinkingBlockCount,
      gotFacets.thinkingChars,
      gotFacets.activeSeconds,
      gotOutcome,
      gotWorkType,
      s.estReasoningTokens,
      s.reasoningSource,
      existing?.id ?? null,
      s.totals.cacheCreation1h,
      s.reasoningEffort,
      canonicalJson(s.reasoningEffortLevels),
    ],
  );

  const results = new Map<
    string,
    { blockId: number; isError: boolean | null; text: string; timestamp: string | null }[]
  >();
  const toolUseBlocks: ToolUseBlock[] = [];
  const messageIds: number[] = [];

  const insertMessage = db.prepare(
    `INSERT INTO message(
       session_id, seq, source_uuid, parent_source_uuid, role, model, stop_reason,
       timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, raw
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  );
  const insertBlock = db.prepare(
    `INSERT INTO block(
       message_id, session_id, ordinal, type, text, tool_name, tool_use_id, tool_input, tool_result
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  );

  try {
    for (const message of s.messages) {
      const messageId = Number(
        insertMessage.run(
          sessionId,
          message.seq,
          message.sourceUuid,
          message.parentSourceUuid,
          message.role,
          message.model,
          message.stopReason,
          message.timestamp,
          message.usage?.input ?? null,
          message.usage?.output ?? null,
          message.usage?.cacheRead ?? null,
          message.usage?.cacheCreation ?? null,
          canonicalJson(message.raw),
        ).lastInsertRowid,
      );
      messageIds.push(messageId);

      for (const block of message.blocks) {
        const blockId = Number(
          insertBlock.run(
            messageId,
            sessionId,
            block.ordinal,
            block.blockType,
            block.text,
            block.toolName,
            block.toolUseId,
            block.toolInput === undefined ? null : canonicalJson(block.toolInput),
            block.toolResult,
          ).lastInsertRowid,
        );
        if (block.blockType === "tool_use") {
          toolUseBlocks.push({
            messageId,
            callBlockId: blockId,
            timestamp: block.calledAt ?? message.timestamp,
            block,
          });
        } else if (block.blockType === "tool_result" && block.toolUseId != null) {
          const queue = results.get(block.toolUseId) ?? [];
          queue.push({
            blockId,
            isError: block.isError,
            text: block.toolResult ?? "",
            timestamp: message.timestamp,
          });
          results.set(block.toolUseId, queue);
        }
      }
    }
  } finally {
    insertBlock.finalize();
    insertMessage.finalize();
  }

  const insertToolCall = db.prepare(
    `INSERT INTO tool_call(
       session_id, message_id, call_block_id, result_block_id, tool_kind, tool_name,
       mcp_server, tool_base_name, tool_use_id, input, input_bytes, is_error, has_result,
       output_preview, output_bytes, duration_ms, ordinal, timestamp
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  );
  const resultTaken = new Map<string, number>();
  try {
    for (const call of toolUseBlocks) {
      const name = call.block.toolName ?? "";
      const classified = classifyTool(name);
      // IDs can recur in retained logs. Pair occurrences one-to-one; reusing
      // the last result for every call doubles volume and changes outcomes.
      const id = call.block.toolUseId;
      let taken = id == null ? 0 : (resultTaken.get(id) ?? 0);
      const queue = id == null ? undefined : results.get(id);
      // Orphan and surplus results remain in the transcript but cannot answer
      // a call that had not been emitted when those results were recorded.
      while (queue?.[taken] != null && (queue[taken]?.blockId ?? 0) < call.callBlockId) {
        taken += 1;
      }
      const result = queue?.[taken];
      if (id != null) resultTaken.set(id, taken + 1);
      const resultBlockId = result?.blockId ?? null;
      const isError = result?.isError ?? null;
      const output = result?.text ?? null;
      const input = call.block.toolInput === undefined ? null : canonicalJson(call.block.toolInput);
      const resultTimestamp = result?.timestamp ?? null;
      insertToolCall.run(
        sessionId,
        call.messageId,
        call.callBlockId,
        resultBlockId,
        classified.kind,
        name,
        classified.mcpServer,
        classified.baseName,
        call.block.toolUseId,
        input,
        input == null ? null : byteLength(input),
        isError == null ? null : Number(isError),
        Number(resultBlockId != null),
        output == null ? null : previewHeadTail(output, 500),
        output == null ? null : byteLength(output),
        durationBetween(call.timestamp, resultTimestamp),
        call.block.ordinal,
        call.timestamp,
      );
      // Inner calls share the wrapper's call block and record no result block
      // of their own: the wrapper's result is one combined output, and linking
      // it again would count its bytes once per inner call.
      for (const inner of call.block.innerToolCalls ?? []) {
        const innerClassified = classifyTool(inner.toolName);
        const innerInput = inner.toolInput === undefined ? null : canonicalJson(inner.toolInput);
        insertToolCall.run(
          sessionId,
          call.messageId,
          call.callBlockId,
          null,
          innerClassified.kind,
          inner.toolName,
          innerClassified.mcpServer,
          innerClassified.baseName,
          inner.toolUseId,
          innerInput,
          innerInput == null ? null : byteLength(innerInput),
          inner.isError == null ? null : Number(inner.isError),
          0,
          null,
          null,
          null,
          call.block.ordinal,
          call.timestamp,
        );
      }
    }
  } finally {
    insertToolCall.finalize();
  }

  const insertFileRef = db.prepare(
    `INSERT INTO file_ref(session_id, message_id, path, rel_path, ext, operation, timestamp)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );
  try {
    for (const ref of refs) {
      insertFileRef.run(
        sessionId,
        messageIds[ref.messageIdx] ?? null,
        ref.path,
        ref.relPath,
        ref.ext,
        ref.operation,
        ref.timestamp,
      );
    }
  } finally {
    insertFileRef.finalize();
  }

  const usage = materializeModelUsage(db, sessionId);
  runStatement(db, "UPDATE session SET estimated_cost_usd = ?1 WHERE id = ?2", [
    totalCost(sessionCostParts(usage, { model: s.model, usage: s.totals })),
    sessionId,
  ]);
  materializeSessionEconomics(db, sessionId);
  materializeContextWindow(db, sessionId);

  return sessionId;
}

function claudeSpawnToolUseIds(parsed: ParsedSession): string[] {
  if (parsed.session.tool !== "claude_code") {
    return [];
  }
  const spawnToolUseIds = new Set<string>();
  for (const message of parsed.session.messages) {
    for (const block of message.blocks) {
      if (
        block.blockType === "tool_use" &&
        (block.toolName === "Task" || block.toolName === "Agent") &&
        block.toolUseId != null
      ) {
        spawnToolUseIds.add(block.toolUseId);
      }
    }
  }
  return [...spawnToolUseIds];
}
