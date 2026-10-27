// hooks/lib/gates/turn-boundary.ts — W516 turn-boundary message queue (the Amp M3
// lift, research-ampcode.md §M3): operator direct-messages (kind NOTE,
// target = sid) queue in the bus while the agent works and are checked at the
// STOP GATE — the turn boundary — even for interactive sessions. SendMessage
// stays interrupts-only; this composes with the W502 stop-gate completion
// enforcer (laneCompletion runs first; the drain fires on clean stops).

import { existsSync } from "node:fs";
import type { HookInput } from "../hookio.ts";
import { resolveLaneContext } from "../lanes/lane-completion.ts";
import { selfLaneStopNotice } from "../lanes/lane-stop-decision.ts";
import { run } from "../run.ts";

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
	return resolveLaneContext(top.out.trim())?.sid ?? hook.session_id ?? null;
}

/** Direct messages without explicit acceptance, oldest first. A hook or WS
 * cursor can pass the event without clearing this queue. */
export function pendingTurnMessages(
	db: MessageStore,
	sid: string,
): TurnMessage[] {
	const rows = db
		.query(
			"SELECT e.id, e.ts, e.source, e.kind, e.payload FROM direct_message_receipts r JOIN events e ON e.id = r.event_id WHERE r.sid = ? AND r.state != 'ACCEPTED' ORDER BY e.id",
		)
		.all(sid) as {
		id: number;
		ts: number;
		source: string;
		kind: string;
		payload: string | null;
	}[];
	return rows
		.filter((r) => !selfLaneStopNotice({ ...r, target: sid }))
		.map((r) => {
			let note = "";
			try {
				const payload = JSON.parse(r.payload ?? "{}") as {
					note?: string;
					q?: string;
					answer?: string;
					consult?: string;
				};
				note =
					r.kind === "consult"
						? `${payload.consult ?? "consult"} asks: ${payload.q ?? ""}`
						: r.kind === "consult.answer"
							? `${payload.consult ?? "consult"} answered: ${payload.answer ?? ""}`
							: String(payload.note ?? "");
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
		`TURN-BOUNDARY INBOX (${msgs.length}): directed event(s) await your action.`,
		...lines,
		`Process each now. Read the full queue with coord inbox --as ${sid}; accept only events you acted on.`,
		...(msgs.length <= 5
			? msgs.map((m) => `  coord ack ${m.id} --as ${sid}`)
			: [`  coord ack <event-id> --as ${sid}`]),
		"Then stop again.",
	].join("\n");
}
