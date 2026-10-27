// work-fence.ts — W643 claim-token fence (oh-my-codex lift, research #6):
// `work take` mints a random claim token, stores ONLY its sha256 on the item
// row, and prints the raw token once. Terminal writes (`work done`) must
// present a token whose hash matches the CURRENT row — a stale writer (a
// zombie lane whose claim was reclaimed and re-taken) presents the OLD token,
// mismatches, and fails instead of clobbering the replacement claim. The raw
// token travels to the legitimate claimant by three machine-local channels:
// take's one-time stdout, the KLH_CLAIM_TOKEN env dispatch/supervise pin on
// spawn, and .fleet/lane-context.json claimToken (the durable channel —
// settings-env merges can drop env pins). Hashed rows predate nothing: a NULL
// hash (claims minted before W643, non-graph writers) closes ungated.
import { createHash, randomBytes } from "node:crypto";

export const claimTokenMint = (): string => randomBytes(24).toString("hex");

export const claimTokenHash = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

/** Verify a presented token vs the row's stored hash. `ok` on a NULL
 * hash (legacy grace), mismatch/missing verdicts carry the refusal text. */
export function claimTokenVerdict(
	row: { claim_token_hash?: string | null },
	provided: string | null | undefined,
): { ok: boolean; why?: string } {
	const want = row.claim_token_hash;
	if (!want) return { ok: true };
	if (!provided) return { ok: false, why: TOKEN_MISSING };
	if (claimTokenHash(provided) !== want) return { ok: false, why: TOKEN_STALE };
	return { ok: true };
}

// refusal texts assembled from parts — the W511 completion scan must never
// flag this file's own vocabulary (fake-completion.ts doctrine)
const TOKEN_MISSING = `claim token required (--token or ${["KLH", "CLAIM", "TOKEN"].join("_")}) — minted once at \`work take\`; after a reclaim, re-take mints a new one`;
const TOKEN_STALE =
	"claim token does not match the current claim — the claim was re-taken; this stale writer is refused";

/** W643 evidence-gated terminal transition (oh-my-codex lift, research #7):
 * an item declares regex patterns the closing evidence must EACH match —
 * in the summary, a product path, or the added diff lines. Absence rejects
 * the transition ITSELF (the W511 scan flags post-hoc markers; this requires
 * positive evidence). Parse + check live here; prepareCompletion calls
 * evidenceCheck() once the diff is assembled. */
export function evidencePatternsOf(
	raw: string | null | undefined,
): string[] | null {
	if (!raw) return null;
	const s = raw.trim();
	if (!s.startsWith("[")) return [s];
	const arr: unknown = JSON.parse(s); // malformed JSON throws — caller dies
	if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string"))
		throw new Error(
			"evidence: expected a JSON array of regex strings or one regex",
		);
	return arr as string[];
}

/** Returns the UNSATISFIED patterns — empty array = evidence complete. */
export function evidenceCheck(
	patterns: string[],
	ev: { summary: string; paths: string[]; diffText: string },
): string[] {
	const hay = [ev.summary, ev.paths.join("\n"), ev.diffText];
	return patterns.filter((p) => {
		const re = new RegExp(p);
		return !hay.some((h) => re.test(h));
	});
}
