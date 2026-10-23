// carrier-probe.test.ts — W1244: offline pins for the carrier-probe pure
// parts (no network, no credentials — the live A/B evidence lives in
// benchmarks.md; the CLI legs are integration-tested by running it).
import { describe, expect, test } from "bun:test";
import { REVIEW_FRAME } from "../../../suspenders/hooks/lib/oracle-frame.ts";
import {
	buildReviewPrompt,
	emptyContentFailure,
	stressPrompt,
	tokenCostUsd,
} from "./carrier-probe.ts";

describe("carrier-probe W1244", () => {
	test("review prompt = oracle frame + whole diff, uncapped", () => {
		const p = buildReviewPrompt("diff --git a/x b/x\n+b\n");
		expect(p.startsWith(REVIEW_FRAME)).toBe(true);
		expect(p.endsWith("DIFF:\ndiff --git a/x b/x\n+b\n")).toBe(true);
	});

	test("W1236 negative: empty content is a leg failure with diagnostics", () => {
		expect(
			emptyContentFailure({
				content: "",
				finishReason: "length",
				completionTokens: 1500,
			}),
		).toBe(
			"review leg returned empty content (finish_reason=length, completion_tokens=1500)",
		);
		// finish_reason absent + no usage → unknown, no completion count
		expect(emptyContentFailure({ content: null })).toBe(
			"review leg returned empty content (finish_reason=unknown)",
		);
		// whitespace-only content counts as empty; real content passes
		expect(emptyContentFailure({ content: "  \n " })).toContain(
			"empty content",
		);
		expect(emptyContentFailure({ content: "VERDICT: PASS" })).toBeNull();
	});

	test("cost math: usage.cost wins, per-$M fallback, null on missing tokens", () => {
		expect(
			tokenCostUsd({
				usageCost: 0.0345,
				promptTokens: 1_000_000,
				completionTokens: 0,
				promptUsdPerM: 2,
				completionUsdPerM: 10,
			}),
		).toBe(0.0345);
		expect(
			tokenCostUsd({
				promptTokens: 500_000,
				completionTokens: 100_000,
				promptUsdPerM: 2,
				completionUsdPerM: 10,
			}),
		).toBeCloseTo(2.0);
		expect(
			tokenCostUsd({
				promptTokens: null,
				completionTokens: null,
				promptUsdPerM: 2,
				completionUsdPerM: 10,
			}),
		).toBeNull();
	});

	test("stress pad targets the ask without changing the frame or diff", () => {
		const p = stressPrompt("DIFFBODY", 10_000);
		expect(p.startsWith(REVIEW_FRAME)).toBe(true);
		expect(p.endsWith("DIFF:\nDIFFBODY")).toBe(true);
		// ~4 chars/token heuristic: 10k tokens ≈ 40k chars of pad + frame
		expect(p.length).toBeGreaterThan(35_000);
	});
});
