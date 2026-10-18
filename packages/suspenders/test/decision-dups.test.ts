// decision-dups.test.ts — W798 anchor extraction + duplicate collapse
// (pure functions, no board fixture).
import { describe, expect, test } from "bun:test";
import { collapseDups, decisionAnchor } from "../hooks/board/decision-dups.ts";

describe("decisionAnchor", () => {
	test("path token ≥3 segments wins, :digits stripped, case-folded", () => {
		expect(
			decisionAnchor("scrub rule for /srv/x/dev/wake.ts:42 ADDED lines"),
		).toBe("/srv/x/dev/wake.ts");
	});
	test("dotted key ≥3 parts anchors; plain words never anchor", () => {
		expect(
			decisionAnchor("fact key lesson.routing.invalid-model needs a ruling"),
		).toBe("lesson.routing.invalid-model");
		expect(decisionAnchor("ship or hold?")).toBeNull();
	});
});

describe("collapseDups", () => {
	test("same project+anchor: newest is primary (dup_count), rest carry dup_of", () => {
		const recs = [
			{ id: 1, state: "OPEN", project: "p", question: "x /p/a/wake.ts y" },
			{ id: 2, state: "OPEN", project: "p", question: "x /p/a/wake.ts y" },
			{ id: 3, state: "OPEN", project: "p", question: "x /p/a/wake.ts y" },
		];
		const out = collapseDups(recs);
		expect(out[2].dup_count).toBe(3);
		expect(out[0].dup_of).toBe(3);
		expect(out[1].dup_of).toBe(3);
	});
	test("different project, no-anchor, or resolved rows never collapse", () => {
		const recs = [
			{ id: 4, state: "OPEN", project: "q", question: "x /p/a/wake.ts y" },
			{ id: 5, state: "ANSWERED", project: "p", question: "x /p/a/wake.ts y" },
			{ id: 6, state: "OPEN", project: "p", question: "ship or hold?" },
		];
		expect(collapseDups(recs)).toEqual(recs);
	});
});
