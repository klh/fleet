import { describe, expect, test } from "bun:test";
import {
	armStats,
	armVerdict,
	cohortArm,
	spec,
	zeroOutShare,
	type LaneArmRow,
} from "./context-rightsizing-ab.ts";
import { parseVerb } from "../hooks/lib/verb-kit.ts";

const row = (
	tokens: number,
	cacheShare: number | null,
	outPerMin: number | null,
): LaneArmRow => ({ work: "W1", tokens, cacheShare, outPerMin });

const claim = (work: string, lastClaim: number) => ({ work, lastClaim });

const attr = (fresh: number, cached: number, out: number, agentMs: number) => ({
	fresh,
	cached,
	out,
	agentMs,
});

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

	test("zeroOutShare — zeros over non-null out/min values, empty-safe", () => {
		expect(
			zeroOutShare([
				row(1_000, 0.5, 0),
				row(2_000, 0.5, 0),
				row(3_000, 0.5, 300),
			]),
		).toBe(2 / 3);
		expect(zeroOutShare([row(1_000, 0.5, null)])).toBe(0);
		expect(zeroOutShare([])).toBe(0);
	});

	test("zero-token rows keep n but never enter the token median", () => {
		const s = armStats([row(1_000_000, 0.5, 100), row(0, null, null)], 0);
		expect(s.n).toBe(2);
		expect(s.medianTokens).toBe(1_000_000);
	});
});

describe("context-rightsizing-ab cohortArm (W1138 review fixes)", () => {
	test("membership = last claim in window; close time is NOT exposure", () => {
		// W1138 itself: claimed pre-window, closed post-window — the closing
		// lane read the OLD brief, so it belongs to neither arm's exposure
		// cohort. The old close-time rule wrongly counted it post-window.
		const out = cohortArm(
			[claim("W1", 1_000), claim("W2", 3_000)],
			new Map([
				["W1", "DONE"],
				["W2", "DONE"],
			]),
			new Map([
				["W1", attr(100, 200, 10, 60_000)],
				["W2", attr(100, 200, 10, 60_000)],
			]),
			2_000,
			4_000,
		);
		expect(out.rows.map((r) => r.work)).toEqual(["W2"]);
		expect(out.done).toBe(1);
	});

	test("churn counts against completion — no survivorship 100%", () => {
		// The old armRows picked state IN ('DONE','FAILED') only; a cohort of
		// 1 done + 45 running rendered completion=100%. The review rejected
		// exactly that. Now every claimed item is in the denominator.
		const out = cohortArm(
			[claim("W1", 1_000), claim("W2", 1_100), claim("W3", 1_200)],
			new Map([
				["W1", "DONE"],
				["W2", "CLAIMED"],
				["W3", "READY"],
			]),
			new Map([["W1", attr(100, 200, 10, 60_000)]]),
			0,
			2_000,
		);
		expect(out.done).toBe(1);
		expect(out.churn).toBe(2);
		expect(out.failed).toBe(0);
		expect(out.rows).toHaveLength(3);
	});

	test("attributed burn accrues for churn rows too; missing attr reads zero", () => {
		const out = cohortArm(
			[claim("W1", 500), claim("W2", 600)],
			new Map([
				["W1", "FAILED"],
				["W2", "RELEASED"],
			]),
			new Map([["W2", attr(300, 700, 30, 120_000)]]),
			0,
			2_000,
		);
		expect(out.failed).toBe(1);
		expect(out.churn).toBe(1);
		expect(out.rows[0]?.tokens).toBe(0);
		expect(out.rows[0]?.cacheShare).toBeNull();
		expect(out.rows[1]?.tokens).toBe(1_000);
		expect(out.rows[1]?.cacheShare).toBeCloseTo(0.7);
	});
});

describe("context-rightsizing-ab armVerdict (never declares comparable)", () => {
	test("below the floor: PENDING, quote nothing", () => {
		const v = armVerdict(0, 10);
		expect(v).toContain("PENDING");
		expect(v).not.toMatch(/COMPARABLE/i);
	});

	test("at the floor: MEASURED — comparability is judged, not declared", () => {
		const v = armVerdict(10, 10);
		expect(v).toContain("ARMS MEASURED");
		expect(v).not.toMatch(/COMPARABLE/i);
	});
});

describe("context-rightsizing-ab verb door (W651 strict parse)", () => {
	test("known flags parse; defaults apply on absent optionals", () => {
		const p = parseVerb(spec, [
			"--landing",
			"2026-10-22T19:29:40+02:00",
			"--min-n",
			"5",
		]);
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.parsed.flag("--landing")).toBe("2026-10-22T19:29:40+02:00");
			expect(p.parsed.flag("--min-n")).toBe("5");
		}
	});

	test("unknown option dies — no silent argv bypass", () => {
		const p = parseVerb(spec, ["--minn", "5", "--landing", "x"]);
		expect(p.ok).toBe(false);
		if (!p.ok) expect(p.message).toContain("unknown option: --minn");
	});

	test("missing required --landing dies with the usage line", () => {
		const p = parseVerb(spec, []);
		expect(p.ok).toBe(false);
		if (!p.ok) expect(p.message).toContain("usage: context-rightsizing-ab");
	});

	test("a trailing flag with no value is not a landing instant", () => {
		const p = parseVerb(spec, ["--landing"]);
		expect(p.ok).toBe(false);
	});
});
