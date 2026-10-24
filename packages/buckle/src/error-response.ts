// src/error-response.ts — the buckle-GENERATED error body + the scrub rule
// (W1259 extraction from handlers.ts — the file sat one line under the
// 1500-line hard limit, so the error face moved to its own module). Two
// documented exceptions stay documented: upstream pass-through errors ride
// the upstream's body verbatim (client-error), and mid-stream failures
// speak SSE (the status is already sent).
import { PROBLEM_SLUGS, problem } from "./citizenship.ts";

/** Buckle-GENERATED error body: problem+json with the stable code in `code`
 *  (http-citizenship). */
export function errorResponse(
	status: number,
	why: string,
	code?: string | null,
): Response {
	return problem({
		status,
		code: code ?? `buckle.${PROBLEM_SLUGS[status] ?? "problem"}`,
		why: code ? `belt: ${code} — ${scrubText(why)}` : scrubText(why),
	});
}

/** /Users/<name> paths and key material never leave through an error. */
export function scrubText(text: string): string {
	return text.replace(/\/Users\/[^/\s'"]+/g, "~");
}
