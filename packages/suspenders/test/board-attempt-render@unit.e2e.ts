// test/board-attempt-render@unit.e2e.ts — W2267.4.2.1: deterministic tests
// for the attempt-mode geometry/inspector lib (hooks/lib/board/
// attempt-render.ts) and the ONE honest domain in activity-scale.ts.
// Browser geometry + strip assembly ride e2e/board-card-activity.spec.ts.
import { expect, test } from "@playwright/test";
import type { AttemptTimeline } from "../hooks/lib/board/activity-contract.ts";
import {
	ACTIVITY_BIN_MS,
	ACTIVITY_STEP_PX,
	fmtHHmm,
	spectralBins,
} from "../hooks/lib/board/activity-scale.ts";
import {
	attemptRows,
	attemptTip,
	attemptX,
	hitTest,
} from "../hooks/lib/board/attempt-render.ts";

const T0 = 1_700_000_000_000;
const W = 380;

function fixture(): AttemptTimeline {
	return {
		windowStart: T0,
		windowEnd: T0 + 90 * 60_000,
		binMs: ACTIVITY_BIN_MS,
		bins: 30,
		attempt: {
			sid: "lane-x",
			index: 2,
			claimStart: T0 + 5 * 60_000,
			claimEnd: null,
			created: T0 - 10 * 60_000,
			firstByteAt: T0 + 8 * 60_000,
			segments: [
				{ kind: "queue", start: T0, end: T0 + 5 * 60_000 },
				{ kind: "firstbyte", start: T0 + 5 * 60_000, end: T0 + 8 * 60_000 },
				{ kind: "tool", start: T0 + 8 * 60_000, end: T0 + 20 * 60_000 },
				{ kind: "unknown", start: T0 + 20 * 60_000, end: T0 + 30 * 60_000 },
				{ kind: "tool", start: T0 + 30 * 60_000, end: T0 + 90 * 60_000 },
			],
		},
		milestones: [{ ts: T0 + 25 * 60_000, commit: "abc1234", stage: "review" }],
	};
}

test.describe("@unit", () => {
	test("short data clips count to its own span — ONE honest domain", () => {
		// root-proven #100836: 38 real 3m bins on a 380px card must yield 38
		// inspectable slots, not the width-derived 63 with 25 future-empty.
		const n = 38;
		const pts: [number, number, number, number][] = Array.from(
			{ length: n },
			(_, i) => [T0 + i * ACTIVITY_BIN_MS, 10, 20, 5],
		);
		const s = spectralBins(pts, W);
		expect(s.count).toBe(n);
		expect(s.bins).toHaveLength(n);
		expect(s.windowEnd).toBe(T0 + n * ACTIVITY_BIN_MS);
		expect(s.startClipped).toBe(false);
	});

	test("dense data keeps the measured width-derived count", () => {
		const n = 200;
		const pts: [number, number, number, number][] = Array.from(
			{ length: n },
			(_, i) => [T0 + i * ACTIVITY_BIN_MS, 10, 20, 5],
		);
		const s = spectralBins(pts, 40 * ACTIVITY_STEP_PX);
		expect(s.count).toBe(40);
		expect(s.startClipped).toBe(true);
	});

	test("single point gets exactly one slot, window end = start + bin", () => {
		const s = spectralBins([[T0, 1, 1, 1]], W);
		expect(s.count).toBe(1);
		expect(s.windowStart).toBe(T0);
		expect(s.windowEnd).toBe(T0 + ACTIVITY_BIN_MS);
	});

	test("fmtHHmm renders the owner-approved compact local form", () => {
		const t = new Date(2026, 10, 2, 9, 52).getTime();
		expect(fmtHHmm(t)).toBe("09:52");
	});

	test("attemptX maps window bounds to 0..width, clamped", () => {
		const a = fixture();
		expect(attemptX(a.windowStart, a.windowStart, a.windowEnd, W)).toBe(0);
		expect(attemptX(a.windowEnd, a.windowStart, a.windowEnd, W)).toBe(W);
		const past = attemptX(a.windowEnd + 60_000, a.windowStart, a.windowEnd, W);
		expect(past).toBe(W);
	});

	test("hitTest: every segment kind reachable; milestone wins over segment", () => {
		const a = fixture();
		const rows = attemptRows(a);
		const kinds = new Set(rows.segs.map((s) => s.kind));
		expect([...kinds].sort()).toEqual([
			"firstbyte",
			"queue",
			"tool",
			"unknown",
		]);
		// mid-window x=190 → the tool segment T0+8..T0+20min
		const mid = hitTest(rows, W / 2, a.windowStart, a.windowEnd, W);
		expect(mid?.kind).toBe("tool");
		// milestone at T0+25min → x≈316.7; diamond claims ±MS_HALF+1 px
		const ms = a.milestones[0];
		if (!ms) throw new Error("fixture has no milestone");
		const msX = attemptX(ms.ts, a.windowStart, a.windowEnd, W);
		const hit = hitTest(rows, msX, a.windowStart, a.windowEnd, W);
		expect(hit?.kind).toBe("milestone");
		expect(hit?.commit).toBe("abc1234");
	});

	test("attemptTip preserves provenance wording per kind", () => {
		const a = fixture();
		const rows = attemptRows(a);
		const stamp = (t: number): string => new Date(t).toISOString();
		const dur = (ms: number): string => `${Math.round(ms / 60000)}m`;
		const fb = rows.segs.find((s) => s.kind === "firstbyte");
		if (!fb) throw new Error("fixture lost firstbyte");
		expect(attemptTip(fb, a, stamp, dur)).toContain(
			"first attributed ledger request — not network latency",
		);
		const tool = rows.segs.find((s) => s.kind === "tool");
		if (!tool) throw new Error("fixture lost tool");
		expect(attemptTip(tool, a, stamp, dur)).toContain(
			"request-row minutes — not tool-call duration",
		);
		const gap = rows.segs.find((s) => s.kind === "unknown");
		if (!gap) throw new Error("fixture lost unknown");
		expect(attemptTip(gap, a, stamp, dur)).toContain("no fact covers this gap");
	});

	test("attemptTip milestone names artifact + commit + stage", () => {
		const a = fixture();
		const rows = attemptRows(a);
		const msRow = rows.milestones[0];
		if (!msRow) throw new Error("fixture has no milestone row");
		const tip = attemptTip(
			msRow,
			a,
			(t) => String(t),
			() => "",
		);
		expect(tip).toContain("artifact · review");
		expect(tip).toContain("commit abc1234");
	});
});
