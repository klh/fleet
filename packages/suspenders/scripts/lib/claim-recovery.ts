export type RecoverableClaim = {
	id: string;
	owner_sid: string;
	state: "CLAIMED" | "RUNNING";
	title: string;
	updated_at: number;
};

/** Registered lanes keep their original retry history; manual owners stay put.
 * A claim is "ours" when its `take --origin` stamp is this executor's (W613:
 * executor-id stamps; legacy hostname stamps match via the .local normalizer). */
export function recoverableClaims(
	rows: unknown,
	registered: Set<string>,
	now: number,
	ownerGated: (title: string) => boolean,
	originIsOurs: (origin: string) => boolean,
): RecoverableClaim[] {
	if (!Array.isArray(rows)) return [];
	return rows.filter(
		(r): r is RecoverableClaim =>
			r !== null &&
			typeof r === "object" &&
			typeof r.id === "string" &&
			/^W\d+(?:\.\d+)*$/.test(r.id) &&
			typeof r.owner_sid === "string" &&
			/^autow[\w.-]+$/.test(r.owner_sid) &&
			!registered.has(r.owner_sid) &&
			(r.state === "CLAIMED" || r.state === "RUNNING") &&
			typeof r.title === "string" &&
			!ownerGated(r.title) &&
			typeof r.origin === "string" &&
			originIsOurs(r.origin) &&
			typeof r.updated_at === "number" &&
			Number.isFinite(r.updated_at) &&
			now - r.updated_at >= 15 * 60_000,
	);
}
