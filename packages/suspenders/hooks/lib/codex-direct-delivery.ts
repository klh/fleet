// The coord WS subscriber calls this only for events addressed to its own
// session. An app-server RPC receipt is transport delivery, never a Fleet
// inbox acknowledgement; the Codex agent acknowledges after it acts.
import {
	type CodexDelivery,
	type CoordDirectEvent,
	steerCodexDirectEvent,
} from "./codex-steer.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECT_KINDS = new Set(["NOTE", "consult", "consult.answer"]);

export type DeliveryStore = {
	query: (sql: string) => {
		get: (...args: unknown[]) => unknown;
	};
};

export function codexThreadForSession(
	store: DeliveryStore,
	sid: string,
): string | null {
	const row = store
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`codex.thread.${sid}`) as { value?: string } | undefined;
	return row?.value && UUID.test(row.value) ? row.value : null;
}

/** Managed lanes (W1052.2.2) bank the per-lane steer socket next to the
 * thread fact; a path, not a UUID — absent for detached exec lanes. */
export function codexSockForSession(
	store: DeliveryStore,
	sid: string,
): string | null {
	const row = store
		.query("SELECT value FROM facts WHERE key = ?")
		.get(`codex.sock.${sid}`) as { value?: string } | undefined;
	return row?.value ?? null;
}

export async function deliverSubscribedCodexEvent(
	event: CoordDirectEvent,
	as: string,
	threadId: string | null,
	sock: string | null = null,
	steer: typeof steerCodexDirectEvent = steerCodexDirectEvent,
): Promise<CodexDelivery> {
	if (event.target !== as || !DIRECT_KINDS.has(event.kind))
		return { state: "ignored", reason: "not addressed to this session" };
	if (!threadId)
		return {
			state: "unsupported",
			reason: "session has no Codex thread mapping",
		};
	return steer(event, sock ? { threadId, sock } : { threadId });
}
