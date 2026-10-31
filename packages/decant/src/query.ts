import type { Database } from "bun:sqlite";
import {
  contextTokensFromUsage,
  isCompactBoundary,
  MESSAGE_RAW_META_SQL,
  parseMessageRawMeta,
} from "./context-window.ts";
import { dayRangePredicate, sessionDatePredicate } from "./date-filter.ts";
import { CONFIRMED_DOSU_SERVER_IDS } from "./dosu.ts";
import type { CostSource, Tool } from "./model.ts";
import { costSourceFor } from "./model-usage.ts";
import {
  parseReasoningEffortLevels,
  withDisplayTitles,
  withNestedSubagents,
} from "./query-titles.ts";
import {
  bracketSearchMatches,
  buildFtsQuery,
  SEARCH_MATCH_END,
  SEARCH_MATCH_START,
} from "./search-query.ts";
import {
  directSessionUserStateExpression,
  type SessionUserState,
  sessionIsUserArchivedExpression,
  sessionUserStatePredicateForDatabase,
} from "./session-user-state.ts";
import { visibleSessionPredicate } from "./session-visibility.ts";
import { durationRankSql, NEAREST_RANK_PERCENTILES_SQL } from "./stats.ts";
import { previewHeadTail } from "./tools.ts";

export interface SessionSummary {
  id: number;
  tool: Tool;
  source_session_id: string;
  title: string | null;
  project_path: string | null;
  model: string | null;
  reasoning_effort: string | null;
  reasoning_effort_levels: string[];
  total_reasoning_tokens: number;
  reasoning_source: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_cost_usd: number;
  /** Where `estimated_cost_usd` came from; `reported` means the source's own
   * recorded cost was used because Decant has no rate for the model. */
  cost_source: CostSource;
  /** Provider route the session's model ran through (OpenCode records one);
   * null for sources that do not record a provider. */
  model_provider: string | null;
  /** Direct user override for this source identity. */
  user_state: SessionUserState | null;
  /** Effective archive state inherited from this row or any current ancestor. */
  is_user_archived: boolean;
  is_archived: boolean;
  is_subagent: boolean;
  parent_session_id: number | null;
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  context_window_tokens: number | null;
  peak_context_tokens: number | null;
  compaction_count: number;
  subagent_count: number;
  subagent_estimated_cost_usd: number;
  /** Actionable ingest diagnostics (currently only dropped/unparsed source lines).
   * Kept under the established wire name so older clients show the safe count. */
  ingest_issue_count: number;
  /** Informational parser/linkage sensors preserved in the archive. */
  informational_ingest_issue_count: number;
  /** Verified Dosu MCP calls made by this session alone. */
  dosu_mcp_direct_calls: number;
  /** Verified Dosu MCP calls made by this session and descendants, depth <= 5. */
  dosu_mcp_tree_calls: number;
  subagents?: SessionSummary[];
}

export interface ListFilter {
  tool?: string | null;
  model?: string | null;
  project?: string | null;
  includeSubagents?: boolean;
  includeNestedSubagents?: boolean;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  from?: string | null;
  to?: string | null;
}

export interface SessionSearchIndexRow {
  id: number;
  title: string | null;
  project: string | null;
  tool: Tool;
  model: string | null;
  started_at: string | null;
}

export interface SessionSummaryRow
  extends Omit<
    SessionSummary,
    | "is_archived"
    | "is_user_archived"
    | "is_subagent"
    | "reasoning_effort_levels"
    | "subagents"
    | "cost_source"
  > {
  is_archived: number;
  is_user_archived: number;
  is_subagent: number;
  reasoning_effort_levels_json: string | null;
  /** `{reported, other}` from the session's model-usage rows; mapped to
   * `cost_source` in TypeScript so it follows the read-time pricing rule. */
  cost_usage_json: string;
}

export function sessionSummarySelect(subagentVisibility: string): string {
  return `
  SELECT s.id, s.tool, s.source_session_id, s.title, p.path AS project_path,
         s.model, s.reasoning_effort,
         s.reasoning_effort_levels AS reasoning_effort_levels_json,
         s.total_reasoning_tokens, s.reasoning_source,
         s.started_at, s.ended_at, s.message_count,
         s.total_input_tokens, s.total_output_tokens, s.estimated_cost_usd,
         (SELECT json_object(
                   'reported', json_group_array(u.model)
                                 FILTER (WHERE u.reported_cost_usd IS NOT NULL),
                   'other', COUNT(*) FILTER (WHERE u.reported_cost_usd IS NULL))
            FROM session_model_usage u
           WHERE u.session_id = s.id) AS cost_usage_json,
         json_extract(s.raw_meta, '$.model_provider') AS model_provider,
         ${directSessionUserStateExpression("s")} AS user_state,
         ${sessionIsUserArchivedExpression("s")} AS is_user_archived,
         s.is_archived, s.is_subagent, s.parent_session_id, s.spawn_tool_use_id,
         s.agent_id, s.agent_type, s.spawn_depth,
         s.context_window_tokens, s.peak_context_tokens, s.compaction_count,
         COALESCE(sa.subagent_count, 0) AS subagent_count,
         COALESCE(sa.subagent_estimated_cost_usd, 0.0) AS subagent_estimated_cost_usd,
         (SELECT COUNT(*) FROM ingest_issue ii
          WHERE ii.source_path = s.source_path AND ii.code = 'unparsed_line')
           AS ingest_issue_count,
         (SELECT COUNT(*) FROM ingest_issue ii
          WHERE ii.source_path = s.source_path AND ii.code != 'unparsed_line')
           AS informational_ingest_issue_count,
         0 AS dosu_mcp_direct_calls,
         0 AS dosu_mcp_tree_calls
  FROM session s
  LEFT JOIN project p ON p.id = s.project_id
  LEFT JOIN (
    SELECT summary_child.parent_session_id, COUNT(*) AS subagent_count,
           COALESCE(SUM(summary_child.estimated_cost_usd), 0.0)
             AS subagent_estimated_cost_usd
    FROM session summary_child
    WHERE summary_child.is_subagent = 1
      AND summary_child.parent_session_id IS NOT NULL
      AND ${visibleSessionPredicate("summary_child")}
      AND ${subagentVisibility}
    GROUP BY summary_child.parent_session_id
  ) sa ON sa.parent_session_id = s.id`;
}

export function listSessions(db: Database, filter: ListFilter = {}): SessionSummary[] {
  const limit = normalizeLimit(filter.limit, 50);
  const offset = normalizeOffset(filter.offset);
  const includeArchived = filter.includeArchived === true;
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tool != null) {
    clauses.push("s.tool = ?");
    params.push(filter.tool);
  }
  if (filter.model != null) {
    clauses.push("COALESCE(s.model, '') = ?");
    params.push(filter.model);
  }
  if (filter.project != null) {
    clauses.push("COALESCE(p.path, '') = ?");
    params.push(filter.project);
  }
  if (filter.includeSubagents !== true) {
    clauses.push("s.is_subagent = 0");
  }
  clauses.push(visibleSessionPredicate("s"));
  clauses.push(sessionUserStatePredicateForDatabase(db, "s", includeArchived));
  const date = sessionDatePredicate("s", filter);
  if (date.sql !== "") {
    clauses.push(date.sql);
    params.push(...date.params);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .query(
      `${sessionSummarySelect(
        sessionUserStatePredicateForDatabase(db, "summary_child", includeArchived),
      )}${where}
       ORDER BY s.started_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as SessionSummaryRow[];
  const summaries = withDisplayTitles(db, rows.map(mapSessionSummary));
  const nested =
    filter.includeNestedSubagents === true
      ? withNestedSubagents(db, summaries, includeArchived)
      : summaries;
  return withDosuMcpEvidence(db, nested, includeArchived);
}

/**
 * Return the complete client-side fuzzy-search haystack without loading
 * messages, tool calls, title fallbacks, or session rollups.
 */
export function sessionSearchIndex(db: Database): SessionSearchIndexRow[] {
  return db
    .query(
      `SELECT s.id, s.title, p.path AS project, s.tool, s.model, s.started_at
       FROM session s
       LEFT JOIN project p ON p.id = s.project_id
       WHERE ${visibleSessionPredicate("s")}
         AND s.is_subagent = 0
         AND ${sessionUserStatePredicateForDatabase(db, "s")}
       ORDER BY s.started_at DESC, s.id DESC`,
    )
    .all() as SessionSearchIndexRow[];
}

export interface SearchHit {
  session_id: number;
  session_title: string | null;
  tool: Tool;
  block_id: number;
  snippet: string;
  message_seq: number;
  timestamp: string | null;
  project: string | null;
  role: string;
  block_type: string;
  href: string;
}

export function search(db: Database, query: string, limitValue = 30): SearchHit[] {
  const limit = normalizeLimit(limitValue, 30, 1000);
  const results: SearchHit[] = [];
  let total: number | null = null;
  while (results.length < limit) {
    const pageLimit = Math.min(100, limit - results.length);
    const page = searchPage(db, query, {
      includeSubagents: true,
      includeTotal: total == null,
      limit: pageLimit,
      offset: results.length,
    });
    total ??= page.total;
    results.push(...page.results);
    if (page.results.length < pageLimit || (total != null && results.length >= total)) {
      break;
    }
  }
  return results.map((hit) => ({
    ...hit,
    snippet: bracketSearchMatches(hit.snippet),
  }));
}

export interface SearchFilter {
  tool?: string | null;
  project?: string | null;
  includeSubagents?: boolean;
  includeTotal?: boolean;
  limit?: number | null;
  offset?: number | null;
  from?: string | null;
  to?: string | null;
}

export interface SearchPage {
  results: SearchHit[];
  total: number | null;
  total_is_capped: boolean;
  elapsed_ms: number;
}

interface SearchHitRow extends Omit<SearchHit, "href" | "snippet"> {
  text_snippet: string | null;
  tool_name_snippet: string | null;
  tool_input_snippet: string | null;
}

const SEARCH_MATCH_START_CODE_POINT = SEARCH_MATCH_START.codePointAt(0) ?? 0xe000;
const SEARCH_MATCH_END_CODE_POINT = SEARCH_MATCH_END.codePointAt(0) ?? 0xe001;

export function searchPage(db: Database, query: string, filter: SearchFilter = {}): SearchPage {
  const startedAt = performance.now();
  const ftsQuery = buildFtsQuery(query);
  const limit = normalizeLimit(filter.limit, 30, 100);
  const offset = normalizeOffset(filter.offset);
  const clauses = [
    "block_fts MATCH ?",
    visibleSessionPredicate("s"),
    sessionUserStatePredicateForDatabase(db, "s"),
  ];
  const params: (string | number)[] = [ftsQuery];
  if (filter.includeSubagents !== true) {
    clauses.push("s.is_subagent = 0");
  }
  if (filter.tool != null) {
    clauses.push("s.tool = ?");
    params.push(filter.tool);
  }
  if (filter.project != null) {
    clauses.push("COALESCE(p.path, '') = ?");
    params.push(filter.project);
  }
  const date = sessionDatePredicate("s", filter);
  if (date.sql !== "") {
    clauses.push(date.sql);
    params.push(...date.params);
  }
  const joins = `
    FROM block_fts
    JOIN block b ON b.id = block_fts.rowid
    JOIN message m ON m.id = b.message_id
    JOIN session s ON s.id = b.session_id
    LEFT JOIN project p ON p.id = s.project_id`;
  const where = `WHERE ${clauses.join(" AND ")}`;
  let total: number | null = null;
  let totalIsCapped = false;
  if (filter.includeTotal !== false) {
    const cappedCount = (
      db
        .query(`SELECT COUNT(*) AS count FROM (SELECT 1 ${joins} ${where} LIMIT 1001)`)
        .get(...params) as { count: number }
    ).count;
    totalIsCapped = cappedCount > 1000;
    total = Math.min(cappedCount, 1000);
  }
  const rows = db
    .query(
      `SELECT b.session_id, s.title AS session_title, s.tool, b.id AS block_id,
              m.seq AS message_seq, m.timestamp, p.path AS project,
              m.role, b.type AS block_type,
              snippet(block_fts, 0, char(${SEARCH_MATCH_START_CODE_POINT}),
                      char(${SEARCH_MATCH_END_CODE_POINT}), '…', 12) AS text_snippet,
              snippet(block_fts, 1, char(${SEARCH_MATCH_START_CODE_POINT}),
                      char(${SEARCH_MATCH_END_CODE_POINT}), '…', 12) AS tool_name_snippet,
              snippet(block_fts, 2, char(${SEARCH_MATCH_START_CODE_POINT}),
                      char(${SEARCH_MATCH_END_CODE_POINT}), '…', 12) AS tool_input_snippet
       ${joins}
       ${where}
       ORDER BY bm25(block_fts, 4.0, 2.0, 1.0), b.id
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as SearchHitRow[];
  return {
    results: rows.map((row) => ({
      session_id: row.session_id,
      session_title: row.session_title,
      tool: row.tool,
      block_id: row.block_id,
      snippet: matchingSnippet(row),
      message_seq: row.message_seq,
      timestamp: row.timestamp,
      project: row.project,
      role: row.role,
      block_type: row.block_type,
      href: `/sessions/${row.session_id}#message-${row.message_seq}`,
    })),
    total,
    total_is_capped: totalIsCapped,
    elapsed_ms: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}

function matchingSnippet(row: SearchHitRow): string {
  const snippets = [row.text_snippet, row.tool_name_snippet, row.tool_input_snippet];
  const snippet =
    snippets.find((candidate) => candidate?.includes(SEARCH_MATCH_START)) ??
    snippets.find((candidate) => candidate != null) ??
    "";
  return snippet;
}

export interface ToolCallFilter {
  tool?: string | null;
  server?: string | null;
  errorsOnly?: boolean;
  sessionId?: number | null;
  project?: string | null;
  from?: string | null;
  to?: string | null;
  minMs?: number | null;
  limit?: number | null;
  offset?: number | null;
}

export interface ToolCallRow {
  id: number;
  session_id: number;
  session_title: string | null;
  project: string | null;
  tool_name: string | null;
  tool_kind: string | null;
  mcp_server: string | null;
  input_preview: string | null;
  input_bytes: number | null;
  output_preview: string | null;
  output_bytes: number | null;
  is_error: boolean | null;
  has_result: boolean | null;
  duration_ms: number | null;
  timestamp: string | null;
  seq: number | null;
}

export interface ToolCallPage {
  calls: ToolCallRow[];
  total: number;
  limit: number;
  offset: number;
  summary: ToolCallSummary | null;
}

export interface ToolCallSummary {
  calls: number;
  errors: number;
  p50_ms: number | null;
  p95_ms: number | null;
}

interface ToolCallDbRow extends Omit<ToolCallRow, "input_preview" | "is_error" | "has_result"> {
  input: string | null;
  is_error: number | null;
  has_result: number | null;
}

export function listToolCalls(db: Database, filter: ToolCallFilter = {}): ToolCallPage {
  const limit = normalizeLimit(filter.limit, 50, 100);
  const offset = normalizeOffset(filter.offset);
  const scopeClauses: string[] = [
    visibleSessionPredicate("s"),
    sessionUserStatePredicateForDatabase(db, "s"),
  ];
  const scopeParams: (string | number)[] = [];
  if (filter.tool != null) {
    scopeClauses.push("t.tool_name = ?");
    scopeParams.push(filter.tool);
  }
  if (filter.server != null) {
    scopeClauses.push("t.mcp_server = ?");
    scopeParams.push(filter.server);
  }
  if (filter.sessionId != null) {
    scopeClauses.push("t.session_id = ?");
    scopeParams.push(filter.sessionId);
  }
  if (filter.project != null) {
    scopeClauses.push("p.path = ?");
    scopeParams.push(filter.project);
  }
  const clauses = [...scopeClauses];
  const params = [...scopeParams];
  if (filter.errorsOnly === true) {
    clauses.push("t.is_error = 1");
  }
  const date = dayRangePredicate("t.timestamp", filter.from, filter.to);
  if (date.sql !== "") {
    clauses.push(date.sql);
    params.push(...date.params);
  }
  if (filter.minMs != null) {
    clauses.push("t.duration_ms >= ?");
    params.push(Math.max(0, filter.minMs));
  }
  // The summary feeds the Tools page cards beside the usage tables, so it shares
  // their session-start scope and skips row-only filters.
  const summaryDate = sessionDatePredicate("s", filter);
  const summaryClauses = [...scopeClauses, summaryDate.sql].filter((clause) => clause !== "");
  const summaryParams = [...scopeParams, ...summaryDate.params];
  const joins = `
    FROM tool_call t
    JOIN session s ON s.id = t.session_id
    LEFT JOIN project p ON p.id = s.project_id
    LEFT JOIN message m ON m.id = t.message_id`;
  const where = `WHERE ${clauses.join(" AND ")}`;
  const summary =
    offset === 0
      ? (db
          .query(
            `WITH filtered AS MATERIALIZED (
         SELECT t.is_error, t.duration_ms
         ${joins}
         WHERE ${summaryClauses.join(" AND ")}
       ),
       ranked AS (
         SELECT duration_ms,
                ${durationRankSql()}
         FROM filtered
         WHERE duration_ms IS NOT NULL
       )
       SELECT
         (SELECT COUNT(*) FROM filtered) AS calls,
         (SELECT COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0)
          FROM filtered) AS errors,
         ${NEAREST_RANK_PERCENTILES_SQL}
       FROM ranked`,
          )
          .get(...summaryParams) as ToolCallSummary)
      : null;
  const { total } = db.query(`SELECT COUNT(*) AS total ${joins} ${where}`).get(...params) as {
    total: number;
  };
  const rows = db
    .query(
      `SELECT t.id, t.session_id, s.title AS session_title, p.path AS project,
              t.tool_name, t.tool_kind,
              t.mcp_server, t.input, t.input_bytes, t.output_preview, t.output_bytes,
              t.is_error, t.has_result, t.duration_ms, t.timestamp, m.seq
       ${joins}
       ${where}
       ORDER BY t.timestamp DESC, t.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ToolCallDbRow[];
  return {
    calls: rows.map(({ input, is_error, has_result, ...row }) => ({
      ...row,
      input_preview: input == null ? null : previewHeadTail(input, 500),
      is_error: is_error == null ? null : is_error === 1,
      has_result: has_result == null ? null : has_result === 1,
    })),
    total,
    limit,
    offset,
    summary,
  };
}

export interface BlockView {
  ordinal: number;
  block_type: string;
  text: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result: string | null;
}

export interface MessageView {
  seq: number;
  role: string;
  timestamp: string | null;
  model: string | null;
  /** Window occupancy for this API call (input + cache_read + cache_creation);
   * null on rows without usage (user/tool/system, deduped stream lines). */
  context_tokens: number | null;
  output_tokens: number | null;
  is_sidechain: boolean;
  is_compact_boundary: boolean;
  compact_trigger: string | null;
  compact_pre_tokens: number | null;
  is_compact_summary: boolean;
  blocks: BlockView[];
}

/**
 * Whole-session counts that stay correct when `messages` holds only one page.
 * A reader counting the returned messages would undercount every paged
 * transcript, so these are aggregated across the session regardless of window.
 */
export interface SessionTotals {
  /** Assistant messages that have something to render. */
  reply_count: number;
  /** `tool_use` blocks across the session. */
  tool_call_count: number;
}

export interface SessionDetail {
  summary: SessionSummary;
  messages: MessageView[];
  subagents: SubagentDetail[];
  /**
   * Present on a real session read. Absent on the `subagents` stubs, which
   * carry structure and a summary but no messages, exactly like the paging
   * fields below.
   */
  totals?: SessionTotals;
  message_offset?: number;
  message_limit?: number | null;
  has_more_messages?: boolean;
}

export interface SubagentDetail extends SessionDetail {
  spawn_tool_use_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
}

export interface SessionReadOptions {
  messageLimit?: number | null;
  messageOffset?: number | null;
}

export interface SessionOutlineItem {
  seq: number;
  text: string;
  kind: "prompt" | "dosu";
  ordinal: number;
}

interface SessionPromptOutlineRow {
  seq: number;
  text: string;
  raw_meta: string | null;
}

interface SessionDosuOutlineRow {
  seq: number;
  text: string;
  ordinal: number;
}

interface MessageBlockRow {
  message_id: number;
  seq: number;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  raw_meta: string | null;
  block_ordinal: number | null;
  block_type: string | null;
  text: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  tool_input: string | null;
  tool_result: string | null;
}

const RESOLVED_BLOCK_TOOL_NAME_SQL = `COALESCE(
  b.tool_name,
  CASE WHEN b.type = 'tool_result' THEN (
    SELECT call.tool_name FROM tool_call call
    WHERE call.session_id = b.session_id AND call.result_block_id = b.id
    LIMIT 1
  ) END
)`;

function sessionSummaryRow(db: Database, id: number): SessionSummaryRow | null {
  return db
    .query(
      `${sessionSummarySelect(
        sessionUserStatePredicateForDatabase(db, "summary_child", true),
      )} WHERE s.id = ?1`,
    )
    .get(id) as SessionSummaryRow | null;
}

// Titles for the root and its whole descendant tree resolve in one batch so a
// session with many subagents costs two queries, not two per subagent.
function sessionTreeSummaries(
  db: Database,
  id: number,
  summaryRow: SessionSummaryRow,
): SessionSummary[] {
  const descendantRows = db
    .query(
      `${sessionSummarySelect(sessionUserStatePredicateForDatabase(db, "summary_child", true))}
       WHERE s.id IN (
         WITH RECURSIVE subtree(id, depth) AS (
           SELECT detail_child.id, 1
           FROM session detail_child
           WHERE detail_child.parent_session_id = ?1
             AND ${visibleSessionPredicate("detail_child")}
             AND ${sessionUserStatePredicateForDatabase(db, "detail_child", true)}
           UNION ALL
           SELECT child.id, subtree.depth + 1
           FROM session child
           JOIN subtree ON subtree.id = child.parent_session_id
           WHERE subtree.depth < 5
             AND ${visibleSessionPredicate("child")}
             AND ${sessionUserStatePredicateForDatabase(db, "child", true)}
         )
         SELECT id FROM subtree
       )
       ORDER BY COALESCE(s.spawn_depth, 0), s.started_at, s.id`,
    )
    .all(id) as SessionSummaryRow[];
  const titled = withDisplayTitles(db, [summaryRow, ...descendantRows].map(mapSessionSummary));
  return withDosuMcpEvidence(db, titled, true);
}

/** A session's summary without reading its transcript. */
export function getSessionSummary(db: Database, id: number): SessionSummary | null {
  const summaryRow = sessionSummaryRow(db, id);
  if (summaryRow == null) {
    return null;
  }
  return sessionTreeSummaries(db, id, summaryRow)[0] ?? mapSessionSummary(summaryRow);
}

export function getSession(
  db: Database,
  id: number,
  options: SessionReadOptions = {},
): SessionDetail | null {
  const summaryRow = sessionSummaryRow(db, id);
  if (summaryRow == null) {
    return null;
  }

  const messages: MessageView[] = [];
  const messageLimit =
    options.messageLimit != null && options.messageLimit > 0 ? options.messageLimit : null;
  const messageOffset = normalizeOffset(options.messageOffset);
  const rows =
    messageLimit == null
      ? (db
          .query(
            `SELECT m.id AS message_id, m.seq, m.role, m.timestamp, m.model,
                    m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
                    ${MESSAGE_RAW_META_SQL} AS raw_meta,
                    b.ordinal AS block_ordinal, b.type AS block_type, b.text,
                    ${RESOLVED_BLOCK_TOOL_NAME_SQL} AS tool_name,
                    b.tool_use_id, b.tool_input, b.tool_result
             FROM message m
             LEFT JOIN block b ON b.message_id = m.id
             WHERE m.session_id = ?1
             ORDER BY m.seq, b.ordinal`,
          )
          .all(id) as MessageBlockRow[])
      : (db
          .query(
            `WITH page_message AS (
               SELECT id
               FROM message
               WHERE session_id = ?1
               ORDER BY seq
               LIMIT ?2 OFFSET ?3
             )
             SELECT m.id AS message_id, m.seq, m.role, m.timestamp, m.model,
                    m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens,
                    ${MESSAGE_RAW_META_SQL} AS raw_meta,
                    b.ordinal AS block_ordinal, b.type AS block_type, b.text,
                    ${RESOLVED_BLOCK_TOOL_NAME_SQL} AS tool_name,
                    b.tool_use_id, b.tool_input, b.tool_result
             FROM page_message pm
             JOIN message m ON m.id = pm.id
             LEFT JOIN block b ON b.message_id = m.id
             ORDER BY m.seq, b.ordinal`,
          )
          .all(id, messageLimit, messageOffset) as MessageBlockRow[]);

  let currentMessageId: number | null = null;
  for (const row of rows) {
    if (currentMessageId !== row.message_id) {
      currentMessageId = row.message_id;
      const rawMeta = parseMessageRawMeta(row.raw_meta);
      messages.push({
        seq: row.seq,
        role: row.role ?? "unknown",
        timestamp: row.timestamp,
        model: row.model,
        context_tokens: contextTokensFromUsage(row),
        output_tokens: row.output_tokens,
        is_sidechain: rawMeta.isSidechain,
        is_compact_boundary: isCompactBoundary(rawMeta),
        compact_trigger: rawMeta.compactTrigger,
        compact_pre_tokens: rawMeta.compactPreTokens,
        is_compact_summary: rawMeta.isCompactSummary,
        blocks: [],
      });
    }
    if (row.block_type != null) {
      messages.at(-1)?.blocks.push({
        ordinal: row.block_ordinal ?? 0,
        block_type: row.block_type,
        text: row.text,
        tool_name: row.tool_name,
        tool_use_id: row.tool_use_id,
        tool_input: row.tool_input,
        tool_result: row.tool_result,
      });
    }
  }

  const evidenced = sessionTreeSummaries(db, id, summaryRow);
  const rootSummary = evidenced[0] ?? mapSessionSummary(summaryRow);
  const childrenByParent = new Map<number, SessionSummary[]>();
  for (const child of evidenced.slice(1)) {
    if (child.parent_session_id == null) {
      continue;
    }
    const siblings = childrenByParent.get(child.parent_session_id);
    if (siblings == null) {
      childrenByParent.set(child.parent_session_id, [child]);
    } else {
      siblings.push(child);
    }
  }

  return {
    summary: rootSummary,
    messages,
    subagents: buildSubagentDetails(childrenByParent, id, 0, new Set([id])),
    totals: getSessionTotals(db, id),
    message_offset: messageLimit != null ? messageOffset : undefined,
    message_limit: messageLimit,
    has_more_messages:
      messageLimit != null ? messageOffset + messages.length < summaryRow.message_count : undefined,
  };
}

/**
 * Session-wide reply and tool-call counts.
 *
 * The renderable-block predicate mirrors the reader's own rule: a text or
 * thinking block counts only when it carries non-whitespace text, and tool
 * blocks always count. Keeping the two in step matters because these totals are
 * displayed next to a transcript the reader can also count by hand.
 */
function getSessionTotals(db: Database, id: number): SessionTotals {
  const row = db
    .query(
      `SELECT
         (SELECT COUNT(*) FROM message m
           WHERE m.session_id = ?1 AND m.role = 'assistant'
             AND EXISTS (
               SELECT 1 FROM block b
               WHERE b.message_id = m.id
                 AND (b.type IN ('tool_use', 'tool_result')
                      OR (b.type IN ('text', 'thinking') AND TRIM(COALESCE(b.text, '')) <> ''))
             )
         ) AS reply_count,
         (SELECT COUNT(*) FROM block b
           WHERE b.session_id = ?1 AND b.type = 'tool_use'
         ) AS tool_call_count`,
    )
    .get(id) as { reply_count: number; tool_call_count: number } | null;
  return {
    reply_count: row?.reply_count ?? 0,
    tool_call_count: row?.tool_call_count ?? 0,
  };
}

/**
 * Return the lightweight prompt and verified Dosu-call outline independently
 * from paged transcript bodies. This keeps every user turn and Dosu
 * optimization reachable from sticky navigation without loading every rich
 * block, tool result, and code sample up front.
 */
export function getSessionOutline(db: Database, id: number): SessionOutlineItem[] | null {
  const session = db.query("SELECT 1 AS present FROM session WHERE id = ?1").get(id);
  if (session == null) {
    return null;
  }
  const promptRows = db
    .query(
      `SELECT m.seq,
              (
                SELECT SUBSTR(b.text, 1, 240)
                FROM block b
                WHERE b.message_id = m.id AND b.type = 'text'
                  AND TRIM(COALESCE(b.text, '')) != ''
                ORDER BY b.ordinal
                LIMIT 1
              ) AS text,
              ${MESSAGE_RAW_META_SQL} AS raw_meta
       FROM message m
       WHERE m.session_id = ?1 AND m.role = 'user'
         AND EXISTS (
           SELECT 1
           FROM block b
           WHERE b.message_id = m.id AND b.type = 'text'
             AND TRIM(COALESCE(b.text, '')) != ''
         )
       ORDER BY m.seq`,
    )
    .all(id) as SessionPromptOutlineRow[];
  const serverPlaceholders = CONFIRMED_DOSU_SERVER_IDS.map(() => "?").join(", ");
  const dosuRows = db
    .query(
      `SELECT m.seq, COALESCE(NULLIF(tc.tool_base_name, ''), tc.tool_name) AS text, tc.ordinal
       FROM tool_call tc
       JOIN message m ON m.id = tc.message_id
       WHERE tc.session_id = ?1
         AND tc.tool_kind = 'mcp'
         AND tc.mcp_server IN (${serverPlaceholders})
       ORDER BY m.seq, tc.ordinal`,
    )
    .all(id, ...CONFIRMED_DOSU_SERVER_IDS) as SessionDosuOutlineRow[];
  const prompts: SessionOutlineItem[] = promptRows
    .filter((row) => !parseMessageRawMeta(row.raw_meta).isCompactSummary)
    .map(({ seq, text }) => ({ seq, text, kind: "prompt", ordinal: -1 }));
  const dosuCalls: SessionOutlineItem[] = dosuRows.map(({ seq, text, ordinal }) => ({
    seq,
    text,
    kind: "dosu",
    ordinal,
  }));
  return [...prompts, ...dosuCalls].sort(
    (left, right) => left.seq - right.seq || left.ordinal - right.ordinal,
  );
}

export interface SessionIngestIssue {
  code: string;
  line_no: number | null;
  error: string;
  raw_line: string | null;
  created_at: string | null;
}

/**
 * Issues recorded when this session's source file was last ingested. Null means
 * no such session; an empty array means the file ingested cleanly.
 *
 * raw_line can contain transcript content: display-local, never logged.
 */
export function sessionIngestIssues(db: Database, sessionId: number): SessionIngestIssue[] | null {
  const session = db.query("SELECT source_path FROM session WHERE id = ?1").get(sessionId) as {
    source_path: string | null;
  } | null;
  if (session == null) {
    return null;
  }
  if (session.source_path == null) {
    return [];
  }
  return db
    .query(
      `SELECT code, line_no, error, raw_line, created_at
       FROM ingest_issue WHERE source_path = ?1 ORDER BY id`,
    )
    .all(session.source_path) as SessionIngestIssue[];
}

function buildSubagentDetails(
  childrenByParent: Map<number, SessionSummary[]>,
  parentId: number,
  depth: number,
  seen: Set<number>,
): SubagentDetail[] {
  if (depth >= 5) {
    return [];
  }
  const details: SubagentDetail[] = [];
  for (const summary of childrenByParent.get(parentId) ?? []) {
    if (seen.has(summary.id)) {
      continue;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(summary.id);
    details.push({
      summary,
      messages: [],
      subagents: buildSubagentDetails(childrenByParent, summary.id, depth + 1, nextSeen),
      spawn_tool_use_id: summary.spawn_tool_use_id,
      agent_id: summary.agent_id,
      agent_type: summary.agent_type,
      spawn_depth: summary.spawn_depth,
    });
  }
  return details;
}

export interface ProjectSummary {
  id: number;
  path: string;
  name: string | null;
  sessions: number;
  estimated_cost_usd: number;
  last_seen_at: string | null;
  is_worktree: boolean;
  root_path: string | null;
  worktree_label: string | null;
  worktree_tool: string | null;
  root_source: string | null;
  worktree_count: number;
  session_tools: string[];
}

interface ProjectSummaryRow extends Omit<ProjectSummary, "is_worktree" | "session_tools"> {
  is_worktree: number;
  session_tools: string | null;
}

export function listProjects(db: Database): ProjectSummary[] {
  const visibleSession = sessionUserStatePredicateForDatabase(db, "s");
  const rows = db
    .query(
      `SELECT p.id, p.path, p.name,
              COALESCE(SUM(CASE WHEN s.is_subagent = 0 THEN 1 ELSE 0 END), 0) AS sessions,
              COALESCE(SUM(s.estimated_cost_usd), 0.0) AS estimated_cost_usd,
              MAX(s.ended_at) AS last_seen_at,
              p.is_worktree, p.root_path, p.worktree_label, p.worktree_tool, p.root_source,
              (SELECT COUNT(*)
               FROM project child
               WHERE child.is_worktree = 1 AND child.root_path = p.path) AS worktree_count,
              GROUP_CONCAT(DISTINCT s.tool) AS session_tools
       FROM project p
       LEFT JOIN session s
         ON s.project_id = p.id
        AND ${visibleSessionPredicate("s")}
        AND ${visibleSession}
       GROUP BY p.id, p.path, p.name
       ORDER BY sessions DESC, p.path ASC`,
    )
    .all() as ProjectSummaryRow[];
  return rows.map((row) => ({
    ...row,
    is_worktree: row.is_worktree !== 0,
    session_tools:
      row.session_tools
        ?.split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool !== "")
        .sort() ?? [],
  }));
}

export function mapSessionSummary(row: SessionSummaryRow): SessionSummary {
  const { reasoning_effort_levels_json: levelsJson, cost_usage_json: costUsage, ...summary } = row;
  const usage = JSON.parse(costUsage) as { reported: string[]; other: number };
  return {
    ...summary,
    cost_source: costSourceFor(usage.reported, usage.other),
    reasoning_effort_levels: parseReasoningEffortLevels(levelsJson),
    is_user_archived: row.is_user_archived !== 0,
    is_archived: row.is_archived !== 0,
    is_subagent: row.is_subagent !== 0,
  };
}

interface DosuMcpEvidenceRow {
  root_id: number;
  direct_calls: number;
  tree_calls: number;
}

/**
 * Adds provenance counts in one bounded aggregate for the complete returned
 * batch. Exact MCP server IDs are the only accepted evidence; no transcript or
 * repository text participates.
 */
function withDosuMcpEvidence(
  db: Database,
  sessions: SessionSummary[],
  includeArchived: boolean,
): SessionSummary[] {
  const flattened = flattenSessionSummaries(sessions);
  if (flattened.length === 0) {
    return sessions;
  }
  const ids = [...new Set(flattened.map((session) => session.id))];
  const serverPlaceholders = CONFIRMED_DOSU_SERVER_IDS.map(() => "?").join(", ");
  const rootVisibility = sessionUserStatePredicateForDatabase(db, "s", includeArchived);
  const childVisibility = sessionUserStatePredicateForDatabase(db, "child", includeArchived);
  const rows = db
    .query(
      `WITH RECURSIVE subtree(root_id, session_id, depth) AS (
         SELECT s.id, s.id, 0
         FROM session s
         WHERE s.id IN (SELECT value FROM json_each(?))
           AND ${visibleSessionPredicate("s")}
           AND ${rootVisibility}
         UNION ALL
         SELECT subtree.root_id, child.id, subtree.depth + 1
         FROM session child
         JOIN subtree ON child.parent_session_id = subtree.session_id
         WHERE subtree.depth < 5
           AND ${visibleSessionPredicate("child")}
           AND ${childVisibility}
       ),
       evidence AS (
         SELECT subtree.root_id, subtree.depth
         FROM subtree
         JOIN tool_call tc ON tc.session_id = subtree.session_id
         WHERE tc.tool_kind = 'mcp'
           AND tc.mcp_server IN (${serverPlaceholders})
       )
       SELECT root_id,
              SUM(CASE WHEN depth = 0 THEN 1 ELSE 0 END) AS direct_calls,
              COUNT(*) AS tree_calls
       FROM evidence
       GROUP BY root_id`,
    )
    .all(JSON.stringify(ids), ...CONFIRMED_DOSU_SERVER_IDS) as DosuMcpEvidenceRow[];
  const byId = new Map(rows.map((row) => [row.root_id, row]));

  const enrich = (session: SessionSummary): SessionSummary => {
    const evidence = byId.get(session.id);
    const subagents = session.subagents?.map(enrich);
    return {
      ...session,
      dosu_mcp_direct_calls: evidence?.direct_calls ?? 0,
      dosu_mcp_tree_calls: evidence?.tree_calls ?? 0,
      ...(subagents == null ? {} : { subagents }),
    };
  };
  return sessions.map(enrich);
}

function flattenSessionSummaries(sessions: SessionSummary[]): SessionSummary[] {
  const flattened: SessionSummary[] = [];
  const visit = (session: SessionSummary) => {
    flattened.push(session);
    for (const subagent of session.subagents ?? []) {
      visit(subagent);
    }
  };
  for (const session of sessions) {
    visit(session);
  }
  return flattened;
}

function normalizeLimit(
  value: number | null | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  return value != null && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

function normalizeOffset(value: number | null | undefined): number {
  return value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
