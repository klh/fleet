import { describe, expect, test } from "bun:test";
import { armStats, type LaneArmRow } from "./context-rightsizing-ab.ts";

const row = (
	tokens: number,
	cacheShare: number | null,
	outPerMin: number | null,
): LaneArmRow => ({ work: "W1", tokens, cacheShare, outPerMin });

describe("context-rightsizing-ab armStats", () => {
	test("empty arm — every stat null, n=0", () => {
		const s = armStats([], 0);
		expect(s.n).toBe(0);
		expect(s.medianTokens).toBeNull();
		expect(s.medianCacheShare).toBeNull();
		expect(s.medianOutPerMin).toBeNull();
		expect(s.agentHours).toBe(0);
	});

	test("odd count — median is the middle value", () => {
		const s = armStats(
			[
				row(1_000_000, 0.8, 200),
				row(2_000_000, 0.6, 400),
				row(4_000_000, 0.4, 800),
			],
			0,
		);
		expect(s.medianTokens).toBe(2_000_000);
		expect(s.medianCacheShare).toBe(0.6);
		expect(s.medianOutPerMin).toBe(400);
	});

	test("zero-token rows keep n but never enter the token median", () => {
		const s = armStats([row(1_000_000, 0.5, 100), row(0, null, null)], 0);
		expect(s.n).toBe(2);
		expect(s.medianTokens).toBe(1_000_000);
	});
});
