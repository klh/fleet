// hooks/lib/govdb-deltas.ts — the W33 delta-log trigger template: one
// column table drives every trigger so the row images can never drift
// from the schemas they mirror, plus the retention prune.
import type { Database } from "bun:sqlite";

// the trigger loop runs AFTER the last CREATE (W132 moved it below the v8
// block): a trigger references its table at creation time, so on a fresh
// DB the loop must see every table it covers already in sqlite_master.
// CREATE TRIGGER IF NOT EXISTS keeps it idempotent and self-healing.
// Extracted (W210) so the v13 ceiling heal can drop stale teams triggers
// and rerun it — one generation mechanism, zero copies of the template.
export function createDeltasTriggers(db: Database): void {
	for (const { tbl, pk, cols } of deltaTables)
		for (const op of ["insert", "update", "delete"] as const) {
			const R = op === "delete" ? "OLD" : "NEW";
			db.run(
				`CREATE TRIGGER IF NOT EXISTS deltas_${tbl}_${op} AFTER ${op.toUpperCase()} ON ${tbl} BEGIN INSERT INTO deltas (ts, tbl, op, pk, before, after) VALUES (${deltaNow}, '${tbl}', '${op}', ${pk.replaceAll("$.", `${R}.`)}, ${op === "insert" ? "NULL" : deltaImg(cols, "OLD")}, ${op === "delete" ? "NULL" : deltaImg(cols, "NEW")}); END`,
			);
		}
}

// one column table drives all 15 triggers so the images can never drift
// from the schemas they mirror. Locks are the highest-churn rows in the
// fleet (a renew per file edit), so lock rows are op-only (before/after
// NULL): a renew carries no information beyond the path, and flooding the
// log with lock images would drown the tables that matter. The json cost
// measured in the noise either way (~5-7 µs/op, op-only vs full-image);
// the other four tables carry full row images.
const deltaImg = (cols: string[], r: "OLD" | "NEW"): string =>
	cols.length
		? `json_object(${cols.map((c) => `'${c}', ${r}.${c}`).join(", ")})`
		: "NULL";
// ms clock: deltas must interleave with events.ts (--since <event-id> picks
// the nearest later seq by ts), so second-granular strftime('%s') would
// order same-second rows wrongly. unixepoch('subsec') is SQLite ≥3.42.
let deltaNow = "strftime('%s','now') * 1000";
try {
	db.query("SELECT unixepoch('subsec') AS ms").get();
	deltaNow = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
} catch {}
const deltaTables: { tbl: string; pk: string; cols: string[] }[] = [
	{
		tbl: "sessions",
		pk: "$.sid",
		cols: [
			"sid",
			"project",
			"role",
			"parent_sid",
			"worktree",
			"started_at",
			"hb",
			"state",
			"capabilities",
			"transcript_path",
		],
	},
	{
		tbl: "claims",
		pk: "$.sid || '/' || $.scope",
		cols: ["sid", "scope", "intent", "hot", "ts", "tp"],
	},
	{ tbl: "locks", pk: "$.path", cols: [] },
	{
		tbl: "facts",
		pk: "$.key",
		cols: ["key", "value", "source", "version", "ts"],
	},
	{
		tbl: "work_items",
		pk: "$.project || '/' || $.id",
		cols: [
			"project",
			"id",
			"parent_id",
			"title",
			"description",
			"state",
			"priority",
			"owner_sid",
			"created_by",
			"scope",
			"why_parallel",
			"result_sha",
			"required",
			"created_at",
			"updated_at",
			"requires",
		],
	},
	// W132 router governance tables — deltas coverage is the audit win:
	// adding entries here is the whole mechanism (v8 block below creates
	// the tables these triggers mirror).
	{
		tbl: "api_keys",
		pk: "$.key_id",
		cols: [
			"key_id",
			"key_hash",
			"jti",
			"name",
			"team",
			"actor",
			"token_type",
			"parent_key_id",
			"scopes",
			"rpm_limit",
			"tpm_limit",
			"expires_at",
			"rotated_at",
			"revoked_at",
			"created_at",
		],
	},
	{
		tbl: "teams",
		pk: "$.team_id",
		cols: [
			"team_id",
			"name",
			"department",
			"rpm_ceiling",
			"tpm_ceiling",
			"tok_ceiling",
			"created_at",
		],
	},
	{
		tbl: "route_audit",
		pk: "$.rid",
		cols: [
			"rid",
			"ts",
			"actor",
			"dialect",
			"hint",
			"candidates",
			"resolved_target",
			"decision",
			"latency_class",
			"error_code",
		],
	},
	{
		tbl: "aid_events",
		pk: "$.id",
		cols: [
			"id",
			"ts",
			"sid",
			"work_item",
			"aid",
			"packet_id",
			"tokens_injected",
			"est_tok_saved",
		],
	},
	{
		tbl: "aid_rollup",
		pk: "$.hour_bucket || '/' || $.aid || '/' || $.domain || '/' || $.model_group",
		cols: [
			"hour_bucket",
			"aid",
			"domain",
			"model_group",
			"injected",
			"skipped",
			"tok_injected",
			"est_tok_saved",
			"requests",
		],
	},
	{
		tbl: "budget_state",
		pk: "$.key_id || '/' || $.window",
		cols: ["key_id", "window", "used_rpm", "used_tpm", "window_start"],
	},
	{
		tbl: "auth_events",
		pk: "$.id",
		cols: ["id", "ts", "actor", "event", "jti", "via"],
	},
	{
		tbl: "admin_audit",
		pk: "$.id",
		cols: ["id", "ts", "actor", "action", "target", "detail"],
	},
];

// W33 retention: the delta log is a ring, not an archive — coord gc trims it
// on the same window as events. Returns rows removed.
export function pruneDeltas(db: Database, olderThanMs: number): number {
	return db
		.query("DELETE FROM deltas WHERE ts < ?")
		.run(Date.now() - olderThanMs).changes;
}
