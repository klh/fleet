// hooks/board/routes-retry.ts — W970: /api/retry + W2267.3 /api/recover,
// the board faces for the W761 `work retry` requeue verb (FAILED /
// budget-quarantined READY → READY). /api/recover is the plain W970
// contract (requeue only); /api/retry also requests a fresh attempt
// through the existing /api/start dispatch path (distinct actions, never
// two labels on one call). The shared core + checks live in retry-action.
import { json } from "./helpers.ts";
import {
	RecoverRequestSchema,
	RetryRequestSchema,
	itemStateOf,
	recoveryPreflight,
	requeueLeg,
	retryWithAttempt,
} from "./retry-action.ts";

export async function handleRetryActions(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method === "POST" && url.pathname === "/api/retry") {
		const pre = await recoveryPreflight(req, url, RetryRequestSchema);
		if (!pre.ok) return pre.resp;
		return retryWithAttempt(pre.req, pre.repo);
	}
	if (req.method === "POST" && url.pathname === "/api/recover") {
		const pre = await recoveryPreflight(req, url, RecoverRequestSchema);
		if (!pre.ok) return pre.resp;
		// Recover → Ready: canonical requeue only. The normal scheduler may
		// pick READY work later — the reported state is read back from the
		// row (it may already be CLAIMED), never assumed READY.
		const refused = requeueLeg(pre.req, pre.repo);
		if (refused) return refused;
		return json({
			ok: true,
			item: pre.req.id,
			state: itemStateOf(pre.req.project, pre.req.id),
		});
	}
	return null;
}
