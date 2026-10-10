// hooks/lib/lane-inbox.ts — W611: deliver directed events into a RUNNING
// lane's model context. The WS push (coord subscribe) and `coord inbox`
// reach the operator's transcript, not the model (toto-gpt.md: a WS
// subscription is not proof a question reaches the active context). The
// PostToolUse files gate calls drainLaneInbox() on every save: events with
// target = <fleet sid> past the lane cursor render as additionalContext and
// the cursor advances past SHOWN — exactly `coord inbox --ack` semantics,
// minus the lane having to remember to run it.
//
// Local store only: the gate runs per tool call, so it never makes a remote
// round trip — cross-store mail rides the consult-outbox relay into THIS
// governor.db before it is ever drained. Fail-open everywhere: an
// unreadable store must never change a gate verdict.
import { resolveFleetLane } from "./fleetlane.ts";
import { openGovernorDb } from "./govdb.ts";
import type { HookInput } from "./hookio.ts";

// Bound the injection: a steer storm must not swallow the lane's context
// window. Rows beyond the cap stay past the cursor — the next save drains
// them (cursor only ever advances past SHOWN).
const MAX_DRAIN = 5;

type EvRow = {
	id: number;
	kind: string;
	scope: string | null;
	payload: string | null;
};

/** One terse line per event — the fields steer delivery actually carries
 * (consult id, note, pause reason, sha). Unparseable payload → kind only. */
function renderEvent(r: EvRow): string {
	let msg = "";
	try {
		const p = r.payload
			? (JSON.parse(r.payload) as Record<string, unknown>)
			: {};
		const text = p.note ?? p.reason ?? p.q ?? p.what ?? p.summary;
		if (typeof text === "string") msg = text;
		if (typeof p.consult === "string" || typeof p.consult === "number")
			msg = `${String(p.consult).replace(/^C/, "C")} ${msg}`.trim();
		if (typeof p.sha === "string") msg += ` @${p.sha.slice(0, 8)}`;
	} catch {}
	return `#${r.id} ${r.kind}${r.scope ? ` [${r.scope}]` : ""}${msg ? ` — ${msg}` : ""}`;
}

/** The testable core: drain undelivered directed events for ONE fleet sid.
 * Returns the additionalContext block, or null when nothing is pending. */
export function drainLaneInboxFor(sid: string): string | null {
	try {
		const db = openGovernorDb();
		try {
			const cur =
				(
					db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
						event_id: number;
					} | null
				)?.event_id ?? 0;
			const rows = db
				.query(
					"SELECT id, kind, scope, payload FROM events WHERE target = ? AND id > ? ORDER BY id LIMIT ?",
				)
				.all(sid, cur, MAX_DRAIN + 1) as EvRow[];
			if (!rows.length) return null;
			const shown = rows.slice(0, MAX_DRAIN);
			// advance past SHOWN only; never backwards (a concurrent `inbox
			// --ack` may already be ahead — the upsert WHERE keeps monotonicity)
			db.query(
				"INSERT INTO cursors (sid, event_id) VALUES (?, ?) ON CONFLICT(sid) DO UPDATE SET event_id = excluded.event_id WHERE excluded.event_id > event_id",
			).run(sid, Math.max(...shown.map((r) => r.id)));
			const more = rows.length > MAX_DRAIN;
			return [
				`coord-inbox: ${shown.length} undelivered event(s) delivered mid-work:`,
				...shown.map((r) => `  ${renderEvent(r)}`),
				...(more
					? ["  … more pending — the next tool result delivers them"]
					: []),
			].join("\n");
		} finally {
			db.close();
		}
	} catch {
		return null; // fail-open: store trouble is never a gate verdict
	}
}

/** Files-gate seam: resolve the fleet lane from the hook's cwd + process
 * chain; no lane identity (a human's own session) drains nothing. */
export function drainLaneInbox(hook: HookInput): string | null {
	const lane = resolveFleetLane(hook.cwd ?? process.cwd());
	if (!lane) return null;
	return drainLaneInboxFor(lane.sid);
}
