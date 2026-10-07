// test/coord-worker.test.ts — W529: the pure coord-worker decisions + the
// coordinator bootstrap bounds. The bounds section of the bootstrap is the
// load-bearing deliverable (mission W529): no outward-facing actions, never
// resolving a NEED_DECISION, at most ONE item, exits cleanly. The launchd
// unit itself (plist + manifest parity, linux/win32 renders) is covered by
// services-manifest.test.ts, which iterates the whole manifest.
import { describe, expect, test } from "bun:test";
import {
	COORD_TAG,
	COORD_WORKER_SID,
	coordBootstrap,
	coordRunDecision,
	isCoordinatorItem,
	parseCoordReady,
} from "../scripts/lib/coord-worker-decide.ts";

describe("coord-worker run decision", () => {
	const GOOD = {
		coordinatorLive: false,
		frontUp: true,
		minted: { key: "bksk_x", keyId: "k1" },
	};
	test("all green → run", () => {
		expect(coordRunDecision(GOOD)).toEqual({
			mode: "run",
			why: "front up, key minted, no live interactive coordinator — governed run goes",
		});
	});
	test("interactive coordinator's warm transcript → skip-live", () => {
		expect(coordRunDecision({ ...GOOD, coordinatorLive: true }).mode).toBe(
			"skip-live",
		);
	});
	test("front down or mint failed → refuse (fail-closed W463 posture)", () => {
		expect(coordRunDecision({ ...GOOD, frontUp: false }).mode).toBe("refuse");
		expect(coordRunDecision({ ...GOOD, minted: null }).mode).toBe("refuse");
	});
	test("skip-live outranks refuse", () => {
		expect(
			coordRunDecision({
				coordinatorLive: true,
				frontUp: false,
				minted: null,
			}).mode,
		).toBe("skip-live");
	});
});

describe("coordinator-class items (tag)", () => {
	test("tag match: bare, comma-list, negation", () => {
		expect(isCoordinatorItem("coord")).toBe(true);
		expect(isCoordinatorItem("fleet,coord")).toBe(true);
		expect(isCoordinatorItem("coord extra")).toBe(true);
		expect(isCoordinatorItem("coordinate")).toBe(false);
		expect(isCoordinatorItem(null)).toBe(false);
		expect(isCoordinatorItem(undefined)).toBe(false);
		expect(COORD_WORKER_SID).toBe("coordworker");
	});
	test("parseCoordReady reads renderRow rows incl. trailing #tags", () => {
		const ROWS = [
			"  · W601   alpha item #coord",
			"  · W602   beta item",
			"  · W603   gamma item #fleet,coord",
			"  · W604   delta: fix #123 bug",
			"",
		].join("\n");
		const parsed = parseCoordReady(ROWS);
		expect(parsed.map((r) => r.id)).toEqual(["W601", "W602", "W603", "W604"]);
		expect(parsed.map((r) => r.tags)).toEqual([
			"coord",
			null,
			"fleet,coord",
			null,
		]);
		expect(parsed[3].title).toBe("delta: fix #123 bug");
		const coord = parsed.filter((r) => isCoordinatorItem(r.tags));
		expect(coord.map((r) => r.id)).toEqual(["W601", "W603"]);
	});
});

describe("coordinator bootstrap bounds", () => {
	const text = coordBootstrap({
		sid: "coordworker",
		repo: "/repo",
		bin: "/prefix/bin",
		model: "test-model",
	});
	test("the four mission bounds are verbatim present", () => {
		expect(text).toMatch(/NO outward-facing actions/);
		expect(text).toMatch(/NEVER resolve a decision/);
		expect(text).toMatch(/no board \/api\/ack or \/api\/answer/);
		expect(text).toMatch(/AT MOST ONE item this run/);
		expect(text).toMatch(/EXIT CLEANLY/);
	});
	test("command paths carry the installed prefix bin", () => {
		expect(text).toContain("/prefix/bin/coord.ts inbox --as coordworker");
		expect(text).toContain("/prefix/bin/coord.ts consult-reply");
		expect(text).toContain("/prefix/bin/work.ts ready");
		expect(text).toContain("/prefix/bin/work.ts take <id> --as coordworker");
		expect(text).toContain("/prefix/bin/coord.ts capsule set --as coordworker");
	});
	test("item workflow: #coord tag + worktree create + done --sha", () => {
		expect(text).toContain(`#${COORD_TAG}`);
		expect(text).toContain("worktree.ts create <id>");
		expect(text).toContain("work.ts done <id> --sha <branch-head>");
	});
	test("identity + cadence line", () => {
		expect(text).toContain('"coordworker"');
		expect(text).toContain("every 900s");
		expect(text).toContain("executor test-model");
	});
});
