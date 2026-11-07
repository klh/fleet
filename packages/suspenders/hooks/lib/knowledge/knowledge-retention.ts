// hooks/lib/knowledge/knowledge-retention.ts — W2845: the retention
// watermark for TERMINAL knowledge rows (state retired|graveyard). Lifted
// from Apple PKG expired_stable_graph (8rank.ai apple-intelligence-
// personal-knowledge-graph, 2026-10-28): retracted rows keep confidence +
// provenance behind a prune watermark instead of living forever.
//
// Ours: retire() is a soft tombstone only (state=retired; graveyard is the
// other terminal) and NOTHING ever prunes terminal rows — recall/decay/
// curate exclude them, but the rows (and their FTS index entries) sit in
// knowledge.db for the machine's lifetime. This sweep flips
// terminal-and-past-the-window rows to state='archived', the read-side
// watermark state:
//   - recall ranking already excludes them (LIVE_STATES_SQL = NOT IN
//     ('retired','graveyard') — 'archived' is not live, same bucket);
//   - the row KEEPS every field: confidence, stamps, provenance,
//     contributors, graveyard_reason — provenance survives the prune;
//   - append-only doctrine intact: DELETE never runs; supersedes_id rows
//     live-forever are never candidates (a live row pointing BACK at an
//     archived heir still resolves — the link is provenance, not liveness).
//
// Watermark semantics: the clock rides updated_at (bumped by retire/
// graveyard at disposal time — the terminal entry stamp), never ts (the
// original write): a 90-day window starts when the row was retired, not
// when it was born. A terminal row whose updated_at is NULL (never
// happened — the convergence backfills it) falls back to ts; both NULL is
// not past any window and stays.
//
// Bounded pass (streams-over-buffers): RETENTION_BATCH rows per fire, so
// a huge graveyard drains over fires, never one unbounded transaction.
// Never touches live rows: the candidate WHERE names the terminal states
// exactly, and a CAS guard (state IN ('retired','graveyard')) on the
// UPDATE keeps a row that woke mid-pass (promoted back) live.
//
// One summary event per PASS that pruned (ids + count, no fact text —
// knowledge-plane discipline): kind knowledge.retention, scope knowledge,
// source knowledge-retention — the emitCurate shape.
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// the default window — 90 days past terminal disposal
export const RETENTION_DEFAULT_DAYS = 90;
export const RETENTION_TERMINAL_STATES = ["retired", "graveyard"] as const;
export const RETENTION_STATE_ARCHIVED = "archived";
export const RETENTION_BATCH = 500;

export interface RetentionOptions {
	/** prune window in days (a retention_days config value); 0 = disabled */
	retentionDays: number;
	/** test seam for the clock */
	now?: number;
	/** max rows flipped per pass (default 500) */
	batch?: number;
	/** false (default) = dry-run: report the due rows, write nothing */
	act?: boolean;
}

export interface RetentionSweep {
	/** the window actually applied (config, post-validation) */
	retentionDays: number;
	/** terminal rows past the window this pass considered */
	candidates: number;
	/** rows flipped to archived */
	archived: { id: number }[];
}

/**
 * The retention config reader — knowledge.json per W1253 config-over-code:
 * JSON.parse is the ONE parser (no yaml, no Bun.YAML), machine-level
 * (~/.config/klh/knowledge.json, 0600 discipline like knowledge-sync.json),
 * no file = defaults. Shape (zod, the W1238.4 schema law):
 *   { "retention_days": 90 }
 * A retention_days of 0 DISABLES the prune (rows keep forever — the
 * explicit opt-out); the reader accepts int 1..3650, everything else throws
 * with the parse error (drift fails LOUD, never silently a bad window).
 */
export const RetentionConfigSchema = z.object({
	retention_days: z
		.number()
		.int()
		.min(0)
		.max(3650)
		.default(RETENTION_DEFAULT_DAYS),
});
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

/** readSyncConfig-shape reader: no file = defaults; bad file throws. */
export function readRetentionConfig(path: string): RetentionConfig {
	let body: string | null = null;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > 8192)
			throw new Error("invalid knowledge config file");
		body = readFileSync(path, "utf8");
	} catch (e) {
		if (e instanceof Error && /invalid knowledge config/.test(e.message))
			throw new Error(
				`Invalid knowledge configuration: ${path} — retention prune disabled until fixed`,
			);
		return { retention_days: RETENTION_DEFAULT_DAYS }; // ENOENT — defaults
	}
	const parsed = RetentionConfigSchema.safeParse(JSON.parse(body));
	if (!parsed.success)
		throw new Error(
			`Invalid knowledge configuration: ${path} — ${parsed.error.message}`,
		);
	return parsed.data;
}

/** The machine conf path (config-over-code: repos carry placeholders). */
export const knowledgeConfPath = (): string =>
	process.env.SUSPENDERS_KNOWLEDGE_CONF ??
	join(process.env.HOME ?? "", ".config", "klh", "knowledge.json");

const DAY_MS = 86_400_000;

/**
 * ONE retention pass. Pure over its (kb, opts) inputs — the CLI face, the
 * heartbeat runner, and the test all call this. Reads candidates bounded,
 * flips under the terminal-state CAS, emits one summary event when rows
 * pruned. Never throws on empty/absent tables (pre-migration kb heals on
 * next open — a sweep firing first is a no-op, never a crash).
 */
export function retentionSweep(
	kb: Database,
	opts: RetentionOptions,
): RetentionSweep {
	const out: RetentionSweep = {
		retentionDays: opts.retentionDays,
		candidates: 0,
		archived: [],
	};
	if (opts.retentionDays <= 0) return out; // disabled — the explicit opt-out
	const now = opts.now ?? Date.now();
	const cutoff = now - opts.retentionDays * DAY_MS;
	const batch = opts.batch ?? RETENTION_BATCH;
	let rows: { id: number; updated_at: number | null; ts: number }[] = [];
	try {
		rows = kb
			.query(
				`SELECT id, updated_at, ts FROM knowledge WHERE state IN ('retired', 'graveyard') ORDER BY COALESCE(updated_at, ts) LIMIT ?`,
			)
			.all(batch) as { id: number; updated_at: number | null; ts: number }[];
	} catch {
		return out; // no knowledge table yet — nothing to prune
	}
	const due = rows.filter((r) => (r.updated_at ?? r.ts) < cutoff);
	out.candidates = due.length;
	if (opts.act !== true) return out; // dry-run — the report IS the output
	for (const r of due) {
		const changed = kb
			.query(
				`UPDATE knowledge SET state = '${RETENTION_STATE_ARCHIVED}' WHERE id = ? AND state IN ('retired', 'graveyard')`,
			)
			.run(r.id);
		if (Number(changed.changes) > 0) out.archived.push({ id: r.id });
	}
	return out;
}
