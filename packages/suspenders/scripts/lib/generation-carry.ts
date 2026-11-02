// generation-carry.ts — W2546: generation-only upgrade legitimacy (owner
// corrections 2026-11-02 #100967/#100970). An unattended reviewed-main
// carry may auto-approve ONLY a candidate whose launchd unit differs from
// the live unit by the immutable code entry moving to the published
// generation's bundle — every other plist key (env, auth, db, binds, cwd,
// schedule) byte-identical. Anything broader is a genuinely unapproved
// semantic change: it stays pending for the owner, never auto-applied.
import { z } from "zod";

/** A launchd unit's parseable face (Schema law: the boundary parses, the
 * core never hand-casts). passthrough is the correctness point: zod
 * STRIPS unknown keys by default, which would silently drop the exact
 * env/cwd/KeepAlive fields the generation-only comparison must protect —
 * every plist key rides along and gets compared. */
export const LaunchdUnitSchema = z
	.object({
		Label: z.string(),
		ProgramArguments: z.array(z.string()),
	})
	.passthrough();
export type LaunchdUnit = z.infer<typeof LaunchdUnitSchema>;

/** Parse plutil-converted JSON TEXT into a validated unit; null = not a
 * parseable unit (the caller reports "unit not parseable"). */
export function parseLaunchdUnit(bytes: string | null): LaunchdUnit | null {
	if (bytes === null) return null;
	try {
		const parsed = LaunchdUnitSchema.safeParse(JSON.parse(bytes));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** argv half of the rule: same length, every unchanged index byte-equal,
 * EXACTLY ONE changed index, which WAS a server entry and IS the new
 * bundle path (owner acceptance: exactly-one). */
export function argvOnlyGenerationEntry(
	beforeArgs: readonly string[],
	afterArgs: readonly string[],
	bundlePath: string,
): { ok: boolean; reason?: string } {
	if (beforeArgs.length !== afterArgs.length)
		return { ok: false, reason: "argument count changed" };
	const changed: number[] = [];
	for (let i = 0; i < afterArgs.length; i++) {
		if (beforeArgs[i] === afterArgs[i]) continue;
		changed.push(i);
		if (afterArgs[i] !== bundlePath)
			return {
				ok: false,
				reason: `argument ${i} changed to a non-generation path`,
			};
		if (!/\/(?:src\/server\.ts|server\.bundle\.js)$/.test(beforeArgs[i]))
			return {
				ok: false,
				reason: `argument ${i} is not the immutable code entry`,
			};
	}
	if (changed.length === 0)
		return { ok: false, reason: "candidate equals live unit" };
	if (changed.length > 1)
		return {
			ok: false,
			reason: `more than one argument changed (${changed.join(",")})`,
		};
	return { ok: true };
}

/** Full-unit rule: plist keys other than ProgramArguments byte-identical,
 * then the argv rule. Parsed units in, verdict out — pure. */
export function generationOnlyCandidate(
	beforeUnit: LaunchdUnit | null,
	candidateUnit: LaunchdUnit | null,
	bundlePath: string,
): { ok: boolean; reason?: string } {
	if (beforeUnit === null || candidateUnit === null)
		return { ok: false, reason: "unit not parseable" };
	const before = beforeUnit as unknown as Record<string, unknown>;
	const candidate = candidateUnit as unknown as Record<string, unknown>;
	const keys = new Set([...Object.keys(before), ...Object.keys(candidate)]);
	for (const key of keys) {
		if (key === "ProgramArguments") continue;
		if (JSON.stringify(before[key]) !== JSON.stringify(candidate[key]))
			return { ok: false, reason: `plist key changed: ${key}` };
	}
	return argvOnlyGenerationEntry(
		beforeUnit.ProgramArguments,
		candidateUnit.ProgramArguments,
		bundlePath,
	);
}
