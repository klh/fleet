// hooks/board/routes-actions.ts — board writes: /api/answer /api/ack
// /api/advise /api/comment /api/message /api/start /api/ship and the rest of
// the write surface (W157 route module). W1298 decomposition: the routes live
// verbatim in per-family modules (routes-answer / routes-note /
// routes-dispatch over advice-queue + dispatch-core); the fetch fragment's
// contract stands — route order preserved by the entry's handler list,
// returns null when nothing matches.
export { recoverPendingAdvice } from "./advice-queue.ts";
import { handleAnswerActions } from "./routes-answer.ts";
import { handleNoteActions } from "./routes-note.ts";
import { handleDispatchActions } from "./routes-dispatch.ts";

export async function handleActions(
	req: Request,
	url: URL,
): Promise<Response | null> {
	for (const h of [
		handleAnswerActions,
		handleNoteActions,
		handleDispatchActions,
	]) {
		const r = await h(req, url);
		if (r) return r;
	}
	return null;
}
