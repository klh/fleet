export interface Claim {
	owner: string;
	lease: string;
	expiresAt: number;
}

export type ReleaseStatus =
	| "none"
	| "expired"
	| "owner-mismatch"
	| "lease-mismatch"
	| "released";

export function releaseLease(
	current: Claim | null,
	request: Pick<Claim, "owner" | "lease">,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: deliberate bug in the starting fixture
	nowMs: number,
): ReleaseStatus {
	if (!current) return "none";
	if (current.owner !== request.owner) return "owner-mismatch";
	return "released";
}
