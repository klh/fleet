// hooks/board-html/fleet-lane-routes.test.ts — W461 stage 3 grouped
// lane/routes view selectors.
import { describe, expect, test } from "bun:test";
import { selectLaneRouteGroups } from "./fleet-lane-routes.ts";

const edge = (over: Partial<Parameters<typeof selectLaneRouteGroups>[0][number]>) => ({
	source: "nas",
	rid: "r",
	lane: "autow461",
	model: "m",
	admittedAt: 1000,
	endedAt: 1100,
	outcome: "policy",
	...over,
});

describe("selectLaneRouteGroups", () => {
	test("groups per observing hub with distinct-lane counts", () => {
		const g = selectLaneRouteGroups([
			edge({ rid: "r1", lane: "a", source: "nas", admittedAt: 100 }),
			edge({ rid: "r2", lane: "a", source: "nas", admittedAt: 200 }),
			edge({ rid: "r3", lane: "a", source: "desktop", admittedAt: 150 }),
		]);
		expect(g.groups).toHaveLength(2);
		const nas = g.groups.find((x) => x.source === "nas");
		expect(nas?.lanes).toBe(1);
		expect(nas?.requests).toBe(2);
		// one lane observed through two origins — groups overlap, total is 1
		expect(g.lanes).toBe(1);
		expect(g.requests).toBe(3);
	});

	test("error filter and active edges", () => {
		const g = selectLaneRouteGroups([
			edge({ rid: "r1", outcome: "errored" }),
			edge({ rid: "r2", outcome: "denied" }),
			edge({ rid: "r3", outcome: "policy", endedAt: null }),
		]);
		expect(g.errors).toBe(2);
		expect(g.groups[0]?.active).toBe(1);
		const errs = selectLaneRouteGroups(
			[
				edge({ rid: "r1", outcome: "errored" }),
				edge({ rid: "r3", outcome: "policy" }),
			],
			{ errorOnly: true },
		);
		expect(errs.requests).toBe(1);
	});

	test("origin filter narrows to one hub", () => {
		const g = selectLaneRouteGroups(
			[
				edge({ rid: "r1", source: "nas" }),
				edge({ rid: "r2", source: "desktop" }),
			],
			{ origin: "desktop" },
		);
		expect(g.groups).toHaveLength(1);
		expect(g.groups[0]?.source).toBe("desktop");
	});
});
