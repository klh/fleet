import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Recover the approved bytes of a reviewed unit whose LaunchAgents file is
 * gone (W2177). The gateway-review proposals hold every staged candidate
 * verbatim; only a candidate for the same destination that re-hashes to the
 * receipt's approved unitSha256 is returned — the fence still sees exactly
 * the approved bytes, never a fresh render. Undefined when nothing matches.
 */
export function recoverApprovedUnit(
	reviewDir: string,
	unit: string,
	unitSha256: string,
): string | undefined {
	let names: string[];
	try {
		names = readdirSync(reviewDir).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	for (const name of names) {
		let proposal: { unit?: unknown; candidate?: unknown };
		try {
			proposal = JSON.parse(readFileSync(join(reviewDir, name), "utf8"));
		} catch {
			continue;
		}
		if (proposal.unit !== unit || typeof proposal.candidate !== "string")
			continue;
		const digest = new Bun.CryptoHasher("sha256")
			.update(proposal.candidate)
			.digest("hex");
		if (digest === unitSha256) return proposal.candidate;
	}
	return undefined;
}
