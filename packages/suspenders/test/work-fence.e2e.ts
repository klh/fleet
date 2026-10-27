import { expect, test } from "./pw";
import {
	claimTokenHash,
	claimTokenMint,
	claimTokenVerdict,
	evidenceCheck,
	evidencePatternsOf,
} from "../hooks/lib/work/work-fence.ts";

test.describe("claim tokens", () => {
	test("mint is 48-hex and unique per call", () => {
		const a = claimTokenMint();
		const b = claimTokenMint();
		expect(a).toMatch(/^[0-9a-f]{48}$/);
		expect(b).not.toBe(a);
	});
	test("verdict: NULL hash = legacy grace (ungated)", () => {
		expect(claimTokenVerdict({ claim_token_hash: null }, null).ok).toBe(true);
		expect(claimTokenVerdict({}, undefined).ok).toBe(true);
	});
	test("verdict: missing token on a gated claim is refused", () => {
		const v = claimTokenVerdict(
			{ claim_token_hash: claimTokenHash("t") },
			null,
		);
		expect(v.ok).toBe(false);
		expect(v.why).toContain("claim token required");
	});
	test("verdict: wrong token refused as a stale writer", () => {
		const t = claimTokenMint();
		const v = claimTokenVerdict(
			{ claim_token_hash: claimTokenHash(t) },
			"f".repeat(48),
		);
		expect(v.ok).toBe(false);
		expect(v.why).toContain("does not match the current claim");
	});
	test("verdict: the minted token itself passes", () => {
		const t = claimTokenMint();
		expect(
			claimTokenVerdict({ claim_token_hash: claimTokenHash(t) }, t).ok,
		).toBe(true);
	});
});

test.describe("evidence patterns", () => {
	test("null/absent/empty = no gate", () => {
		expect(evidencePatternsOf(null)).toBeNull();
		expect(evidencePatternsOf(undefined)).toBeNull();
		expect(evidencePatternsOf("")).toBeNull();
	});
	test("a bare regex string is the single pattern", () => {
		expect(evidencePatternsOf("verified-\\d+")).toEqual(["verified-\\d+"]);
	});
	test("a JSON array carries multiple patterns", () => {
		expect(evidencePatternsOf('["a","b"]')).toEqual(["a", "b"]);
	});
	test("malformed JSON throws", () => {
		expect(() => evidencePatternsOf("[oops")).toThrow();
	});
	test("a non-string array element is rejected", () => {
		expect(() => evidencePatternsOf('["a",1]')).toThrow();
	});
	test("check: a pattern matching any surface satisfies", () => {
		const ev = {
			summary: "nope",
			paths: ["src/x.ts"],
			diffText: "+ trust-fence-verified",
		};
		expect(evidenceCheck(["trust-fence"], ev)).toEqual([]);
	});
	test("check: unsatisfied patterns are reported", () => {
		const ev = { summary: "nothing", paths: [], diffText: "" };
		expect(evidenceCheck(["required-marker"], ev)).toEqual(["required-marker"]);
	});
});
