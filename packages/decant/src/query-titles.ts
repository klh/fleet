/** Session display titles: the two-pass prompt scan behind every listed
 * session's title, the nested-subagent tree join, and the agent-context text
 * rules they share. W1238.6.3: moved verbatim from the vendored query.ts. */

import type { Database } from "bun:sqlite";
import {
  mapSessionSummary,
  type SessionSummary,
  type SessionSummaryRow,
  sessionSummarySelect,
} from "./query.ts";
import { sessionUserStatePredicateForDatabase } from "./session-user-state.ts";
import { visibleSessionPredicate } from "./session-visibility.ts";
import { preview } from "./tools.ts";

export { parseReasoningEffortLevels, withDisplayTitles, withNestedSubagents };

function parseReasoningEffortLevels(value: string | null | undefined): string[] {
  if (value == null || value.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((level): level is string => typeof level === "string" && level !== "")
      : [];
  } catch {
    return [];
  }
}

function withDisplayTitles(db: Database, sessions: SessionSummary[]): SessionSummary[] {
  if (sessions.length === 0) {
    return sessions;
  }
  const placeholders = sessions.map(() => "?").join(", ");
  const ids = sessions.map((session) => session.id);
  // Pass 1 takes only the first plausible candidate per session. CROSS JOIN +
  // INDEXED BY pin the plan to messages -> blocks; otherwise SQLite starts from
  // every text block in the archive.
  //
  // AGENT_CONTEXT_SQL must skip a subset (never a superset) of what
  // isAgentContextText skips: a wrong pass-through is re-checked in JS by pass
  // 2, but a wrong skip silently changes which prompt becomes the title.
  const firstCandidates = db
    .query(
      `SELECT s.id AS session_id, s.is_subagent,
              (SELECT b.text
               FROM message m
               CROSS JOIN block b INDEXED BY idx_block_message ON b.message_id = m.id
               WHERE m.session_id = s.id
                 AND m.role = 'user'
                 AND ${HUMAN_TITLE_MESSAGE_SQL}
                 AND b.type = 'text'
                 AND b.text IS NOT NULL
                 AND TRIM(b.text) != ''
                 AND NOT (${AGENT_CONTEXT_SQL})
               ORDER BY m.seq, b.ordinal
               LIMIT 1) AS text
       FROM session s
       WHERE s.id IN (${placeholders})`,
    )
    .all(...ids) as { session_id: number; is_subagent: number; text: string | null }[];
  const titleBySession = new Map<number, string>();
  const needFullScan: number[] = [];
  for (const row of firstCandidates) {
    if (row.text == null) {
      continue;
    }
    const title = readableUserTitle(row.text, row.is_subagent !== 0);
    if (title != null) {
      titleBySession.set(row.session_id, title);
    } else {
      needFullScan.push(row.session_id);
    }
  }
  // Pass 2, only for sessions whose first candidate was agent context: walk all
  // their user text blocks in order, exactly like the single-pass version did.
  if (needFullScan.length > 0) {
    const scanPlaceholders = needFullScan.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT m.session_id AS session_id, s.is_subagent, b.text
         FROM message m
         JOIN session s ON s.id = m.session_id
         CROSS JOIN block b INDEXED BY idx_block_message ON b.message_id = m.id
         WHERE m.session_id IN (${scanPlaceholders})
           AND m.role = 'user'
           AND ${HUMAN_TITLE_MESSAGE_SQL}
           AND b.type = 'text'
           AND b.text IS NOT NULL
           AND TRIM(b.text) != ''
         ORDER BY m.session_id, m.seq, b.ordinal`,
      )
      .all(...needFullScan) as { session_id: number; is_subagent: number; text: string }[];
    for (const row of rows) {
      if (titleBySession.has(row.session_id)) {
        continue;
      }
      const title = readableUserTitle(row.text, row.is_subagent !== 0);
      if (title != null) {
        titleBySession.set(row.session_id, title);
      }
    }
  }
  return sessions.map((session) => {
    const title =
      titleBySession.get(session.id) ?? readableUserTitle(session.title, session.is_subagent);
    // Always replace the parser fallback. In Codex logs the first normalized
    // "user" row can be a developer prompt rather than something a human typed.
    return { ...session, title };
  });
}

function readableUserTitle(text: string | null | undefined, isSubagent: boolean): string | null {
  if (text == null) {
    return null;
  }
  const trimmed = stripAnsi(text).trim();
  if (trimmed === "") {
    return null;
  }
  if (isSubagent) {
    const task = subagentTaskTitle(trimmed);
    if (task != null) {
      return task;
    }
  }
  if (isAgentContextText(trimmed)) {
    return null;
  }
  return preview(trimmed.replace(/\s+/g, " "), 180);
}

function subagentTaskTitle(text: string): string | null {
  if (/^<teammate-message\b/i.test(text)) {
    const summary = tagAttribute(text, "summary");
    return summary == null ? null : preview(summary.replace(/\s+/g, " ").trim(), 180);
  }
  if (!/^<fork-boilerplate>/i.test(text)) {
    return null;
  }
  const marker = /Your directive:\s*/i.exec(text);
  if (marker == null) {
    return null;
  }
  const directive = text.slice(marker.index + marker[0].length).trim();
  const firstSection = directive.split(/\n\s*\n(?=[A-Z][A-Z /-]{2,}:)/)[0] ?? directive;
  const normalized = firstSection.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : preview(normalized, 180);
}

// Codex stores developer messages as user rows, so check the raw payload role.
// Claude parent files can hold copied sidechain rows that belong to child
// agents, and compact summaries are machine continuations, not prompts.
const HUMAN_TITLE_MESSAGE_SQL = `
  COALESCE(json_extract(m.raw, '$.payload.role'), 'user') = 'user'
  AND COALESCE(json_extract(m.raw, '$.isCompactSummary'), 0) != 1
  AND (
    s.is_subagent = 1
    OR COALESCE(json_extract(m.raw, '$.isSidechain'), 0) != 1
  )
`;

// SQL twin of isAgentContextText for early-exiting title scans. Keep the two in
// sync and this side conservative: LIKE mirrors the case-insensitive prefixes,
// GLOB the case-sensitive ones, and stripAnsi/trimStart nuances fall through
// to the JS check rather than being approximated.
const AGENT_CONTEXT_SQL = `
  LTRIM(b.text) LIKE '<permissions instructions>%'
  OR LTRIM(b.text) LIKE '<local-command-caveat>%'
  OR LTRIM(b.text) LIKE '<local-command-stdout>%'
  OR LTRIM(b.text) LIKE '<local-command-stderr>%'
  OR LTRIM(b.text) LIKE '<local-command-output>%'
  OR LTRIM(b.text) LIKE '<command-name>%'
  OR b.text GLOB '*<environment_context>*'
  OR LTRIM(b.text) GLOB '# AGENTS.md instructions*'
  OR b.text GLOB '*<INSTRUCTIONS>*'
  OR LTRIM(b.text) LIKE 'The following is the Codex agent history%'
  OR LTRIM(b.text) LIKE 'Use prior reviews as context%'
`;

function isAgentContextText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    /^<permissions instructions>/i.test(trimmed) ||
    /^<local-command-caveat>/i.test(trimmed) ||
    /^<local-command-std(?:out|err)>/i.test(trimmed) ||
    /^<local-command-output>/i.test(trimmed) ||
    /^<command-name>/i.test(trimmed) ||
    /^<teammate-message\b/i.test(trimmed) ||
    /^<fork-boilerplate>/i.test(trimmed) ||
    /^You are\s+[`'"]?\/?root[`'"]?,\s+the primary agent\b/i.test(trimmed) ||
    /^<(?:multi_agent_mode|collaboration_mode|skills_instructions|apps_instructions|plugins_instructions|recommended_plugins)>/i.test(
      trimmed,
    ) ||
    trimmed.includes("<environment_context>") ||
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.includes("<INSTRUCTIONS>") ||
    /^The following is the Codex agent history/i.test(trimmed) ||
    /^Use prior reviews as context/i.test(trimmed)
  );
}

function stripAnsi(value: string): string {
  const pattern = `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`;
  return value.replace(new RegExp(pattern, "g"), "");
}

function tagAttribute(value: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedName}="([^"]*)"`, "i");
  return value.match(pattern)?.[1] ?? null;
}

function withNestedSubagents(
  db: Database,
  sessions: SessionSummary[],
  includeArchived: boolean,
): SessionSummary[] {
  if (sessions.length === 0) {
    return sessions;
  }
  const placeholders = sessions.map(() => "?").join(", ");
  const summaryVisibility = sessionUserStatePredicateForDatabase(
    db,
    "summary_child",
    includeArchived,
  );
  const nestedVisibility = sessionUserStatePredicateForDatabase(
    db,
    "nested_child",
    includeArchived,
  );
  const childVisibility = sessionUserStatePredicateForDatabase(db, "child", includeArchived);
  const rows = db
    .query(
      `${sessionSummarySelect(summaryVisibility)}
       WHERE s.id IN (
         WITH RECURSIVE subtree(id) AS (
           SELECT nested_child.id
           FROM session nested_child
           WHERE nested_child.is_subagent = 1
             AND nested_child.parent_session_id IN (${placeholders})
             AND ${visibleSessionPredicate("nested_child")}
             AND ${nestedVisibility}
           UNION ALL
           SELECT child.id
           FROM session child
           JOIN subtree parent ON parent.id = child.parent_session_id
           WHERE child.is_subagent = 1
             AND ${visibleSessionPredicate("child")}
             AND ${childVisibility}
         )
         SELECT id FROM subtree
       )
       ORDER BY COALESCE(s.spawn_depth, 0), s.started_at, s.id`,
    )
    .all(...sessions.map((session) => session.id)) as SessionSummaryRow[];
  if (rows.length === 0) {
    return sessions;
  }

  const childrenByParent = new Map<number, SessionSummary[]>();
  for (const child of withDisplayTitles(db, rows.map(mapSessionSummary))) {
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

  const attach = (session: SessionSummary, depth: number, seen: Set<number>): SessionSummary => {
    if (depth >= 5 || seen.has(session.id)) {
      return session;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(session.id);
    const children = (childrenByParent.get(session.id) ?? []).map((child) =>
      attach(child, depth + 1, nextSeen),
    );
    return children.length === 0 ? session : { ...session, subagents: children };
  };

  return sessions.map((session) => attach(session, 0, new Set()));
}
