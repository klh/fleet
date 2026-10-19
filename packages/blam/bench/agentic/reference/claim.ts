interface Claim {
	owner: string;
	lease: string;
	expiresAt: number;
}
type ReleaseStatus =
	| "none"
	| "expired"
	| "owner-mismatch"
	| "lease-mismatch"
	| "released";

export function releaseLease(
	current: Claim | null,
	request: Pick<Claim, "owner" | "lease">,
	nowMs: number,
): ReleaseStatus {
	if (!current) return "none";
	if (current.expiresAt <= nowMs) return "expired";
	if (current.owner !== request.owner) return "owner-mismatch";
	if (current.lease !== request.lease) return "lease-mismatch";
	return "released";
}
