// Typed lane-stop decision contract: publication and legacy projection share one shape.
const reasons = new Set([
	"transcript_unresolved",
	"assistant_identity_unreadable",
	"assistant_predates_activation",
	"assistant_api_error",
	"assistant_missing_output",
	"assistant_not_observed",
	"turn_deadline_exceeded",
]);
const completionFailures = new Map([
	[
		"Lane completion context does not match this item and owner",
		"completion_context_mismatch",
	],
	[
		"Dispatched completion requires its original lane context and baseline",
		"completion_context_missing",
	],
]);
export const completionBlockCode = (error: unknown): string | null =>
	error instanceof Error
		? (completionFailures.get(error.message) ?? null)
		: null;

export function completionBlockNote(item: string, code: string): string {
	return `${item}: lane_completion_blocked (${code}); completion refused. Inspect the current claim and its bound lane context before retrying.`;
}
export function laneStopNotice(
	raw: string | null,
	source: string | null,
): { project: string; item: string; note: string } | null {
	if (!source) return null;
	let p: Record<string, unknown>;
	try {
		p = JSON.parse(raw ?? "{}");
	} catch {
		return null;
	}
	if (
		!p ||
		typeof p !== "object" ||
		typeof p.project !== "string" ||
		!p.project.trim() ||
		typeof p.item !== "string" ||
		!/^W\d+(?:\.\d+)*$/.test(p.item) ||
		typeof p.note !== "string"
	)
		return null;
	const prefix = `${p.item}: lane_turn_no_output (`;
	const suffix =
		"); no completion attempt consumed. Inspect route/stream and transcript delivery.";
	if (
		!p.note.startsWith(prefix) ||
		!p.note.endsWith(suffix) ||
		!reasons.has(p.note.slice(prefix.length, -suffix.length))
	)
		return null;
	return { project: p.project, item: p.item, note: p.note };
}
export function laneStopDecision(
	project: string,
	item: string,
	sid: string,
	note: string,
	target = sid,
) {
	return {
		kind: "NEED_DECISION",
		scope: "suspenders",
		source: sid,
		// The lane context binds this identity to the responsible claim owner.
		// Keep it even after death: the board can record an owner ruling while
		// retaining the real session to which the answer belongs.
		to: target,
		note,
		extra: {
			project,
			item,
			work: item,
			notice: "lane-stop",
			classification: "operational",
		},
	};
}

/** Internal operational notices remain board incidents, not work for their author. */
export function selfLaneStopNotice(event: {
	kind: string;
	source: string;
	target?: string | null;
	payload: string | null;
}): boolean {
	if (event.kind !== "NEED_DECISION" || event.source !== event.target)
		return false;
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(event.payload ?? "{}");
	} catch {
		return false;
	}
	const transport = laneStopNotice(event.payload, event.source) !== null;
	const completion =
		typeof payload?.code === "string" &&
		[...completionFailures.values()].includes(payload.code) &&
		typeof payload.item === "string" &&
		/^W\d+(?:\.\d+)*$/.test(payload.item) &&
		typeof payload.project === "string" &&
		payload.project.trim().length > 0 &&
		payload.note === completionBlockNote(payload.item, payload.code);
	return (
		payload?.notice === "lane-stop" &&
		payload.classification === "operational" &&
		payload.work === payload.item &&
		(transport || completion)
	);
}

/** Resolve the bound upstream session, retaining dead identities for rulings. */
export function laneStopTarget(
	db: { query(sql: string): { get(...params: unknown[]): unknown } },
	project: string,
	sid: string,
): string {
	const parent = db
		.query(`SELECT parent.sid FROM sessions lane
	 JOIN sessions parent ON parent.sid=lane.parent_sid
	 WHERE lane.sid=? AND lane.project=? AND parent.project=? AND parent.sid!=lane.sid`)
		.get(sid, project, project) as { sid: string } | null;
	return parent?.sid ?? sid;
}
