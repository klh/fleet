// hooks/coord/subscribe-delivery.ts — per-event Codex direct delivery for a
// pushed event addressed to one session. Shared by the per-session
// subscriber (bus.ts cmdSubscribe) and the machine subscriber
// (subscribe-machine.ts, hub-of-one phase 5) — moved verbatim from bus.ts.
import {
	codexSockForSession,
	codexThreadForSession,
	deliverSubscribedCodexEvent,
} from "../lib/executors/codex-direct-delivery.ts";
import { steerCodexDirectEvent } from "../lib/executors/codex-steer.ts";
import { db, type Ev } from "./shared.ts";

/** Chained behind `prev` so a later consult never overtakes an earlier
 * direct message while app-server RPC is still in flight. */
export function queueCodexDelivery(
	prev: Promise<void>,
	event: Ev,
	as: string,
): Promise<void> {
	return prev
		.then(async () => {
			const threadId = codexThreadForSession(db, as);
			if (!threadId) return;
			// Managed lanes steer over their per-lane socket (W1052.2.2);
			// detached exec lanes keep the shared-daemon proxy fallback.
			const sock = codexSockForSession(db, as);
			const proxy = process.env.SUSPENDERS_CODEX_BIN;
			const result = await deliverSubscribedCodexEvent(
				event,
				as,
				threadId,
				sock,
				proxy
					? (direct, opts) =>
							steerCodexDirectEvent(direct, {
								...opts,
								command: [proxy, "app-server", "proxy"],
							})
					: undefined,
			);
			console.error(
				`coord Codex delivery #${event.id}: ${result.state}${result.state === "steered" ? ` turn=${result.turnId}` : ` ${result.reason}`}; Fleet inbox remains durable`,
			);
		})
		.catch((error) => {
			console.error(
				`coord Codex delivery #${event.id}: queued ${String(error)}`,
			);
		});
}
