import type { ResolvedEntry, ResolvedPosture } from "./posture.zod.ts";

export function selectPostureEntries(
	resolved: ResolvedPosture,
	usable: (entry: ResolvedEntry) => boolean,
): ResolvedEntry[] {
	const enabled = resolved.entries.filter(
		(entry) => entry.policy !== "OFF" && entry.lanes !== 0,
	);

	if (!resolved.selection.developmentOverride) {
		return enabled.filter((entry) => entry.policy === "MUST" && usable(entry));
	}

	const usableCan = enabled.filter(
		(entry) => entry.policy === "CAN" && usable(entry),
	);
	if (usableCan.length > 0) return usableCan;

	return enabled.filter((entry) => entry.policy === "MUST" && usable(entry));
}
