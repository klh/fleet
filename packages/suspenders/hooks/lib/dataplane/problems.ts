// problems.ts — W2327: the dataplane's error face — problem+json with the
// AIP canonical-code vocabulary (design doc's table): one typed builder,
// every handler throws DataplaneProblem and the door maps it. Buckle
// precedent (src/error-response.ts) carries `code`/`why` twins; the
// dataplane speaks the design's `detail` + urn type vocabulary.
export type ProblemCode =
	| "invalid_argument"
	| "unauthenticated"
	| "permission_denied"
	| "not_found"
	| "failed_precondition"
	| "internal";

const HTTP_OF: Record<ProblemCode, number> = {
	invalid_argument: 400,
	unauthenticated: 401,
	permission_denied: 403,
	not_found: 404,
	failed_precondition: 409,
	internal: 500,
};

export class DataplaneProblem extends Error {
	constructor(
		readonly code: ProblemCode,
		message: string,
	) {
		super(message);
		this.name = "DataplaneProblem";
	}
}

/** Render one problem as a problem+json Response (the door's only mapper). */
export const problemResponse = (code: ProblemCode, detail: string): Response =>
	Response.json(
		{
			type: `urn:klh:problem:${code.replace(/_/g, "-")}`,
			title: code,
			status: HTTP_OF[code],
			detail,
		},
		{
			status: HTTP_OF[code],
			headers: { "content-type": "application/problem+json" },
		},
	);

/** Map any thrown value to a problem Response; unknowns = internal, and the
 *  message never leaks (scrub law) — the detail names the operation only. */
export const problemFromError = (e: unknown, op: string): Response =>
	e instanceof DataplaneProblem
		? problemResponse(e.code, e.message)
		: problemResponse("internal", `${op} failed`);
