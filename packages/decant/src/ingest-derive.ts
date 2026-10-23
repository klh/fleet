import type { Database } from "bun:sqlite";
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { defaultPricing } from "./cost.ts";
import { withImmediateTransaction } from "./db.ts";
import { firstMessageFields, parseObject } from "./ingest-shared.ts";
import { asBoolean, asInteger, asString, canonicalJson, get } from "./json.ts";
import {
  type Json,
  reasoningEffortLevels,
  recordedReasoningEffort,
  summarizeReasoningEfforts,
  type Tool,
} from "./model.ts";
import { forkHistoryStart } from "./sources/codex.ts";
import { queryRows } from "./sqlite-statements.ts";

export function seedModelPricing(db: Database): void {
  const stored = new Map(
    queryRows<{
      model: string;
      input_per_mtok: number | null;
      output_per_mtok: number | null;
      cache_read_per_mtok: number | null;
      cache_write_per_mtok: number | null;
      cache_write_1h_per_mtok: number | null;
      source: string | null;
    }>(
      db,
      `SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
              cache_write_per_mtok, cache_write_1h_per_mtok, source
         FROM model_pricing`,
    ).map((row) => [row.model, row]),
  );
  // Most syncs change nothing, so skip the write lock unless a seed row is
  // missing or differs. The upsert below repeats the comparison under the lock.
  const pending = [...defaultPricing()].filter(([model, price]) => {
    const row = stored.get(model);
    return (
      row == null ||
      (row.source === "seed" &&
        (row.input_per_mtok !== price.inputPerMtok ||
          row.output_per_mtok !== price.outputPerMtok ||
          row.cache_read_per_mtok !== price.cacheReadPerMtok ||
          row.cache_write_per_mtok !== price.cacheWritePerMtok ||
          row.cache_write_1h_per_mtok !== price.cacheWrite1hPerMtok))
    );
  });
  if (pending.length === 0) {
    return;
  }
  const insert = db.prepare(
    `INSERT INTO model_pricing(
       model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
       cache_write_per_mtok, cache_write_1h_per_mtok, source, updated_at
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'seed', datetime('now'))
     ON CONFLICT(model) DO UPDATE SET
       input_per_mtok = excluded.input_per_mtok,
       output_per_mtok = excluded.output_per_mtok,
       cache_read_per_mtok = excluded.cache_read_per_mtok,
       cache_write_per_mtok = excluded.cache_write_per_mtok,
       cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok,
       updated_at = excluded.updated_at
     WHERE model_pricing.source = 'seed'
       AND (model_pricing.input_per_mtok IS NOT excluded.input_per_mtok
         OR model_pricing.output_per_mtok IS NOT excluded.output_per_mtok
         OR model_pricing.cache_read_per_mtok IS NOT excluded.cache_read_per_mtok
         OR model_pricing.cache_write_per_mtok IS NOT excluded.cache_write_per_mtok
         OR model_pricing.cache_write_1h_per_mtok IS NOT excluded.cache_write_1h_per_mtok)`,
  );
  try {
    withImmediateTransaction(db, () => {
      for (const [model, price] of pending) {
        insert.run(
          model,
          price.inputPerMtok,
          price.outputPerMtok,
          price.cacheReadPerMtok,
          price.cacheWritePerMtok,
          price.cacheWrite1hPerMtok,
        );
      }
    });
  } finally {
    insert.finalize();
  }
}

export function resolveSubagentParents(db: Database): void {
  const rows = queryRows<{
    id: number;
    tool: Tool;
    source_session_id: string;
    raw_meta: string | null;
    source_path: string | null;
    spawn_tool_use_id: string | null;
    agent_id: string | null;
    agent_type: string | null;
    spawn_depth: number | null;
    is_subagent: number;
    parent_session_id: number | null;
    first_fields: string | null;
  }>(
    db,
    `SELECT s.id, s.source_session_id, s.raw_meta, s.source_path, s.spawn_tool_use_id,
              s.agent_id, s.agent_type, s.spawn_depth, s.is_subagent, s.parent_session_id,
              s.tool,
              (SELECT CASE WHEN json_valid(m.raw)
                           THEN json_extract(m.raw, '$.isSidechain', '$.sessionId', '$.agentId')
                      END
               FROM message m
               WHERE m.session_id = s.id
               ORDER BY m.seq
               LIMIT 1) AS first_fields
       FROM session s
       WHERE s.tool IN ('claude_code', 'codex', 'gemini', 'opencode')`,
  );

  const sessionBySource = new Map<string, number>();
  const rootByClaudeSession = new Map<string, number>();
  const rootByChild = new Map<number, number>();
  const inferred = new Map<number, InferredSubagent>();
  for (const row of rows) {
    const info = inferSubagent(row);
    inferred.set(row.id, info);
    sessionBySource.set(sourceKey(row.tool, row.source_session_id), row.id);
    if (!info.isSubagent) {
      if (info.rootKey != null) {
        rootByClaudeSession.set(info.rootKey, row.id);
      }
    }
  }

  for (const row of rows) {
    const info = inferred.get(row.id);
    if (info == null || !info.isSubagent) {
      continue;
    }
    const rootKey = info.rootKey;
    const rootId =
      (rootKey == null ? null : rootByClaudeSession.get(rootKey)) ??
      (rootKey == null ? null : sessionBySource.get(sourceKey(row.tool, rootKey))) ??
      null;
    if (rootId != null) {
      rootByChild.set(row.id, rootId);
    }
  }

  const findSpawner = db.prepare(
    `SELECT b.session_id AS session_id
     FROM block b
     JOIN session s ON s.id = b.session_id
     WHERE b.type = 'tool_use' AND b.tool_use_id = ?1
     ORDER BY s.is_subagent DESC, b.id DESC
     LIMIT 1`,
  );
  // Driving from spawn_agent calls keeps the LIKE off every tool_result in the
  // root session; the planner otherwise walks idx_block_session and reads each
  // result's text.
  const findCodexSpawner = db.prepare(
    `SELECT call.tool_use_id AS tool_use_id
     FROM block call INDEXED BY idx_block_tool
     JOIN block result
       ON result.session_id = call.session_id
      AND result.tool_use_id = call.tool_use_id
      AND result.type = 'tool_result'
     WHERE call.session_id = ?1
       AND call.type = 'tool_use'
       AND call.tool_name = 'spawn_agent'
       AND result.tool_result LIKE ?2
     ORDER BY call.id DESC
     LIMIT 1`,
  );
  const update = db.prepare(
    `UPDATE session
     SET is_subagent = ?1,
         parent_session_id = ?2,
         spawn_tool_use_id = COALESCE(spawn_tool_use_id, ?3),
         agent_id = COALESCE(agent_id, ?4),
         agent_type = COALESCE(agent_type, ?5),
         spawn_depth = COALESCE(spawn_depth, ?6)
     WHERE id = ?7`,
  );
  try {
    withImmediateTransaction(db, () => {
      for (const row of rows) {
        const info = inferred.get(row.id);
        if (info == null || !info.isSubagent) {
          continue;
        }
        const rootId = rootByChild.get(row.id) ?? null;
        let parentId: number | null = null;
        let spawnToolUseId = info.spawnToolUseId;
        if (spawnToolUseId == null && row.tool === "codex" && rootId != null) {
          const spawner = findCodexSpawner.get(rootId, `%${row.source_session_id}%`) as {
            tool_use_id: string;
          } | null;
          spawnToolUseId = spawner?.tool_use_id ?? null;
        }
        if (spawnToolUseId != null) {
          const spawner = findSpawner.get(spawnToolUseId) as { session_id: number } | null;
          if (spawner != null && spawner.session_id !== row.id) {
            parentId = spawner.session_id;
          }
        }
        parentId ??= rootId;
        const nextParent = parentId === row.id ? null : parentId;
        // Rewriting identical values still dirties the session pages, so a
        // resolved archive would log a WAL write per subagent on every pass.
        if (
          row.is_subagent === 1 &&
          row.parent_session_id === nextParent &&
          row.spawn_tool_use_id === (row.spawn_tool_use_id ?? spawnToolUseId) &&
          row.agent_id === (row.agent_id ?? info.agentId) &&
          row.agent_type === (row.agent_type ?? info.agentType) &&
          row.spawn_depth === (row.spawn_depth ?? info.spawnDepth)
        ) {
          continue;
        }
        update.run(
          1,
          nextParent,
          spawnToolUseId,
          info.agentId,
          info.agentType,
          info.spawnDepth,
          row.id,
        );
      }
    });
  } finally {
    update.finalize();
    findCodexSpawner.finalize();
    findSpawner.finalize();
  }
}

/** One-time schema-upgrade backfill. Effort lives only in source records, so
 * unchanged sessions cannot recover it from the archive itself. The checked
 * marker prevents source files that genuinely omit effort from being reparsed
 * on every sync, while normal re-ingest refreshes the value when a file grows. */
export function materializeMissingReasoningEfforts(db: Database): number {
  const pendingStatement = db.prepare(
    `SELECT id, tool, source_session_id, source_path
       FROM session
       WHERE reasoning_effort_checked = 0`,
  );
  let rows: {
    id: number;
    tool: Tool;
    source_session_id: string;
    source_path: string | null;
  }[];
  try {
    rows = pendingStatement.all() as typeof rows;
  } finally {
    pendingStatement.finalize();
  }
  if (rows.length === 0) {
    return 0;
  }

  const efforts: ({ id: number } & ReasoningEffortSummary)[] = [];
  for (const row of rows) {
    if (row.source_path == null) {
      efforts.push({ id: row.id, summary: null, levels: [] });
      continue;
    }
    try {
      efforts.push({ id: row.id, ...reasoningEffortFromSource(row.tool, row.source_path) });
    } catch (error) {
      // Only a missing file is a stable answer; a permission or I/O failure
      // leaves the row unchecked so a later sync retries it.
      if ((error as { code?: string }).code === "ENOENT") {
        efforts.push({ id: row.id, summary: null, levels: [] });
      }
    }
  }
  if (efforts.length === 0) {
    return 0;
  }

  const update = db.prepare(
    `UPDATE session
     SET reasoning_effort = ?2, reasoning_effort_levels = ?3, reasoning_effort_checked = 1
     WHERE id = ?1`,
  );
  try {
    withImmediateTransaction(db, () => {
      for (const row of efforts) {
        update.run(row.id, row.summary, canonicalJson(row.levels));
      }
    });
  } finally {
    update.finalize();
  }
  return efforts.length;
}

interface ReasoningEffortSummary {
  summary: string | null;
  levels: string[];
}

/** Narrow source scan for the one-time effort backfill. It avoids rebuilding
 * every message/block/tool object from a potentially multi-GB archive and
 * leaves the database write transaction for the small update batch only. */
function reasoningEffortFromSource(tool: Tool, path: string): ReasoningEffortSummary {
  const efforts = new Set<string>();
  const scan: EffortScan = { tool, efforts, sawMeta: false, historyStart: null };
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const fd = openSync(path, "r");
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        collectReasoningEffort(scan, pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    collectReasoningEffort(scan, pending + decoder.end());
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort cleanup: preserve the scan result or original read error.
    }
  }
  const levels = reasoningEffortLevels(efforts);
  return { summary: summarizeReasoningEfforts(levels), levels };
}

interface EffortScan {
  tool: Tool;
  efforts: Set<string>;
  sawMeta: boolean;
  historyStart: number | null;
}

function collectReasoningEffort(scan: EffortScan, line: string): void {
  if (line.trim() === "") {
    return;
  }
  try {
    const value = JSON.parse(line) as Json;
    const typ = asString(get(value, "type"));
    if (scan.tool === "codex" && typ === "session_meta" && !scan.sawMeta) {
      scan.sawMeta = true;
      scan.historyStart = forkHistoryStart(get(value, "payload"));
    }
    const ordinal = asInteger(get(value, "ordinal"));
    if (scan.historyStart != null && ordinal != null && ordinal < scan.historyStart) {
      return;
    }
    const effort =
      scan.tool === "claude_code"
        ? recordedReasoningEffort(get(value, "effort"))
        : recordedReasoningEffort(get(get(value, "payload"), "effort"));
    if (effort != null && (scan.tool === "claude_code" || typ === "turn_context")) {
      scan.efforts.add(effort);
    }
  } catch {
    // Parser parity: malformed source rows do not hide valid effort labels.
  }
}

function sourceKey(tool: Tool, sourceSessionId: string): string {
  return `${tool}\0${sourceSessionId}`;
}

interface InferredSubagent {
  isSubagent: boolean;
  rootKey: string | null;
  spawnToolUseId: string | null;
  agentId: string | null;
  agentType: string | null;
  spawnDepth: number | null;
}

function inferSubagent(row: {
  tool: Tool;
  source_session_id: string;
  raw_meta: string | null;
  source_path: string | null;
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  is_subagent: number;
  first_fields: string | null;
}): InferredSubagent {
  const meta = parseObject(row.raw_meta);
  const first = firstMessageFields(row.first_fields);
  const source = get(meta, "source");
  const subagentSource = get(source, "subagent");
  const threadSpawn = get(subagentSource, "thread_spawn");
  const parentThreadId =
    asString(get(meta, "parent_thread_id")) ??
    asString(get(threadSpawn, "parent_thread_id")) ??
    asString(get(meta, "parentSessionId"));
  const fromPath = row.source_path != null && /(?:^|[/\\])subagents(?:[/\\])/.test(row.source_path);
  const isSubagent =
    row.is_subagent !== 0 ||
    fromPath ||
    asBoolean(get(meta, "isSubagent")) === true ||
    asBoolean(get(first, "isSidechain")) === true ||
    subagentSource !== undefined ||
    parentThreadId != null;
  return {
    isSubagent,
    rootKey:
      parentThreadId ?? asString(get(meta, "sessionId")) ?? asString(get(first, "sessionId")),
    spawnToolUseId:
      row.spawn_tool_use_id ??
      asString(get(meta, "spawnToolUseId")) ??
      asString(get(meta, "toolUseId")),
    agentId:
      row.agent_id ??
      asString(get(meta, "agent_nickname")) ??
      asString(get(threadSpawn, "agent_nickname")) ??
      asString(get(meta, "agentId")) ??
      asString(get(first, "agentId")) ??
      (isSubagent && row.tool === "codex" ? row.source_session_id : null),
    agentType:
      row.agent_type ??
      asString(get(meta, "agent_role")) ??
      asString(get(threadSpawn, "agent_role")) ??
      asString(subagentSource) ??
      asString(get(meta, "agentType")) ??
      asString(get(meta, "subagentType")) ??
      asString(get(meta, "subagent_type")),
    spawnDepth:
      row.spawn_depth ?? asInteger(get(threadSpawn, "depth")) ?? asInteger(get(meta, "spawnDepth")),
  };
}
