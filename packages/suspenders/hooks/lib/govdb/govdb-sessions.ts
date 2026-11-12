// hooks/lib/govdb/govdb-sessions.ts — session lifecycle helpers: the shared
// liveness sweep and the W293 session-name bridge.
import type { Database } from "bun:sqlite";
import { transcriptsAliveBatch } from "../lanes/lane-liveness.ts";
import { dieFor } from "../verb-kit.ts";

// Liveness sweep shared by gc, coord bootstrap, the monitor, session-start,
// and the store-server maintenance tick (W2864 — the sweep runs regardless of
// what transport clients ride, because the server owns the db file). Two
// signals: hb-stale (updates only at bootstrap) + transcript-dead for
// TOP-LEVEL rows; parented lanes close at 24h. Never sweeps the coordinator
// (it sleeps between waves) or sessions waiting on an open decision. Swept
// sessions keep owned work — reclaim stays a human call.
export function sweepStaleSessions(
	db: Database,
	maxIdleMs = 20 * 60_000,
): number {
	const now = Date.now();
	const coordinatorSid =
		(
			db
				.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
				.get() as { value: string } | null
		)?.value ?? null;
	let waiting: Set<string>;
	try {
		waiting = new Set(
			(
				db
					.query(
						"SELECT answer_to AS sid FROM decisions WHERE state = 'OPEN' AND answer_to IS NOT NULL",
					)
					.all() as { sid: string }[]
			).map((r) => r.sid),
		);
	} catch {
		waiting = new Set(); // no decisions table yet — board never ran
	}
	let n = 0;
	// W2864: transcript liveness is answered for ALL candidates by ONE bounded
	// walk — the per-row transcriptAlive call re-walked ~/.claude/projects for
	// every stale row (the store-server interval now sweeps on a schedule, so
	// the per-row cost compounds at cadence instead of once per bootstrap).
	const candidates: string[] = [];
	for (const r of db
		.query(
			"SELECT sid, role FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NULL AND hb < ?",
		)
		.all(now - maxIdleMs) as {
		sid: string;
		role: string;
	}[]) {
		if (r.role === "coordinator" || r.sid === coordinatorSid) continue;
		if (waiting.has(r.sid)) continue;
		candidates.push(r.sid);
	}
	const alive = transcriptsAliveBatch(candidates);
	for (const sid of candidates) {
		if (alive.get(sid)) continue;
		db.query(
			"UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'",
		).run(sid);
		n++;
	}
	for (const r of db
		.query(
			"SELECT sid FROM sessions WHERE state = 'RUNNING' AND parent_sid IS NOT NULL AND hb < ?",
		)
		.all(now - 24 * 3_600_000) as { sid: string }[]) {
		db.query(
			"UPDATE sessions SET state = 'CLOSED' WHERE sid = ? AND state = 'RUNNING'",
		).run(r.sid);
		n++;
	}
	return n;
}

// W293 session-name bridge: the user-facing lane name lives in the sessions
// row's tags JSON (`name` key — `coord bootstrap --name` stamps it; coord
// fleet + the board display it). Parse-safe: absent or malformed tags, or a
// non-string/blank name, yield null — a display label never throws.
export function tagNameOf(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const n = (JSON.parse(raw) as { name?: unknown }).name;
		return typeof n === "string" && n.trim() ? n.trim() : null;
	} catch {
		return null;
	}
}

// W846: the sid-expansion guard, moved verbatim from bin/work.ts (1500-line
// cap offset): take/start/done/release resolve a truncated sid to the full
// owner of record before compare. Exact sid wins first — a full sid must
// never die on its own prefix family (autow219 vs autow2190… made
// `work take --as autow219` ambiguous); unknown sids pass through untouched.
const die = dieFor("work");
export function resolveSidOf(db: Database, as: string): string {
	const exact = db.query("SELECT sid FROM sessions WHERE sid = ?").get(as) as
		| { sid: string }
		| undefined;
	if (exact) return exact.sid;
	const sm = db
		.query("SELECT sid FROM sessions WHERE sid LIKE ? || '%'")
		.all(as) as { sid: string }[];
	if (sm.length === 1) return sm[0].sid;
	if (sm.length > 1) die(`ambiguous sid prefix: ${as} — use the full sid`);
	return as;
}
