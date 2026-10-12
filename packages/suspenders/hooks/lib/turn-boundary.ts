// hooks/lib/turn-boundary.ts — W516 turn-boundary message queue (the Amp M3
// lift, research-ampcode.md §M3): operator direct-messages (kind NOTE,
// target = sid) queue in the bus while the lane works and are DRAINED AT THE
// STOP GATE — the turn boundary — instead of injected mid-turn. SendMessage
// stays interrupts-only; this composes with the W502 stop-gate completion
// enforcer (laneCompletion runs first; the drain fires on clean stops).

import { existsSync } from "node:fs";
import type { HookInput } from "./hookio.ts";
import { resolveLaneContext } from "./lane-completion.ts";
import { run } from "./run.ts";

export interface TurnMessage {
	id: number;
	source: string;
	note: string;
}

// the narrow db seam both bun:sqlite and GovernorStore satisfy structurally
export interface MessageStore {
	query(sql: string): {
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	};
}

// same lane identity laneCompletion trusts: resolveLaneContext (the shared
// W516 extraction) — sid only, no item requirement
export function turnBoundarySid(hook: HookInput): string | null {
	const cwd = hook.cwd;
	if (!cwd || !existsSync(cwd)) return null;
	const top = run("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (!top.ok) return null;
	return resolveLaneContext(top.out.trim())?.sid ?? null;
}

/** Operator messages queued past the lane's inbox cursor, oldest first.
 *  Empty when the lane is drained (cursor advanced by `coord inbox --ack`). */
export function pendingTurnMessages(
	db: MessageStore,
	sid: string,
): TurnMessage[] {
	const cur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	const rows = db
		.query(
			"SELECT id, ts, source, payload FROM events WHERE target = ? AND kind = 'NOTE' AND id > ? ORDER BY id",
		)
		.all(sid, cur) as {
		id: number;
		ts: number;
		source: string;
		payload: string | null;
	}[];
	return rows.map((r) => {
		let note = "";
		try {
			note = String(
				(JSON.parse(r.payload ?? "{}") as { note?: string }).note ?? "",
			);
		} catch {}
		return { id: r.id, source: r.source, note };
	});
}

/** The stop-gate feedback that drains the queue: the messages ARE the next
 *  turn's input — the lane processes them, acks, then stops again. */
export function turnBoundaryFeedback(
	msgs: TurnMessage[],
	sid: string,
): string | null {
	if (!msgs.length) return null;
	const lines = msgs
		.slice(-5)
		.map(
			(m) => `  #${m.id} from ${m.source.slice(0, 8)}: ${m.note.slice(0, 200)}`,
		);
	if (msgs.length > 5) lines.unshift(`  … and ${msgs.length - 5} more`);
	return [
		`TURN-BOUNDARY INBOX (${msgs.length}): operator message(s) queued while this lane worked.`,
		...lines,
		`Process each now (act or acknowledge), then run coord inbox --as ${sid} --ack to mark them drained, then stop again.`,
	].join("\n");
}
