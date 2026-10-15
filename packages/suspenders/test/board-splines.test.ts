// test/board-splines.test.ts — W214: the kanban dependency splines. The pure
// client pieces (tkey/depOrder/splineEdges) eval from the shipped TASKS chunk
// bytes (String.raw export) with core helpers injected; page-level asserts
// cover the spline CSS + the legend markup.
import { describe, expect, test } from "bun:test";
import { TASKS } from "../hooks/board-html/tasks.ts";
import { HTML } from "../hooks/bin/fleet-board-html.ts";

type Item = Record<string, unknown>;

const tkeyOf = (t: Item): string =>
	`${String(t.project || "")}\u0000${String(t.id)}`;

function chunkSandbox(): {
	tkey: (t: Item) => string;
	depOrder: (items: Item[]) => Item[];
	splineEdges: (
		ts: Item[],
		vis: Record<string, number>,
	) => { cls: string; from: string; to: string }[];
} {
	const fn = new Function(
		"esc",
		"taskPill",
		"agoShort",
		"window",
		`${TASKS}\nreturn { tkey, depOrder, splineEdges };`,
	);
	return fn(null, null, null, { addEventListener: () => {} });
}

describe("board dependency splines (W214)", () => {
	test("tkey: composite project+id — cross-project id collisions stay distinct", () => {
		const { tkey } = chunkSandbox();
		const a = tkey({ project: "/p1/.git", id: "W1" });
		const b = tkey({ project: "/p2/.git", id: "W1" });
		expect(a).not.toBe(b);
	});

	test("depOrder: provider above dependent, age order kept otherwise", () => {
		const { depOrder } = chunkSandbox();
		const P = { project: "/r/.git", id: "W1", age_s: 30 };
		const Q = { project: "/r/.git", id: "W2", blocked_by: ["W1"], age_s: 1 };
		const R = { project: "/r/.git", id: "W3", age_s: 2 };
		// age order Q(1), R(2), P(30) — depOrder must still lift P above Q
		const ordered = depOrder([Q, R, P]).map((t) => t.id);
		expect(ordered).toEqual(["W3", "W1", "W2"]);
	});

	test("depOrder: transitive chain orders fully; cycle falls back without dropping cards", () => {
		const { depOrder } = chunkSandbox();
		const A = { project: "/r/.git", id: "A", age_s: 3 };
		const B = {
			project: "/r/.git",
			id: "B",
			blocked_by: ["A"],
			age_s: 2,
		};
		const C = {
			project: "/r/.git",
			id: "C",
			blocked_by: ["B"],
			age_s: 1,
		};
		expect(depOrder([C, B, A]).map((t) => t.id)).toEqual(["A", "B", "C"]);
		const X = { project: "/r/.git", id: "X", blocked_by: ["Y"], age_s: 1 };
		const Y = { project: "/r/.git", id: "Y", blocked_by: ["X"], age_s: 2 };
		const cyc = depOrder([X, Y]).map((t) => t.id);
		expect(cyc.sort()).toEqual(["X", "Y"]);
	});

	test("splineEdges: blocked dep→dependent, waiting child→parent; hidden pairs drop", () => {
		const { splineEdges, tkey } = chunkSandbox();
		const A = { project: "/r/.git", id: "W1" };
		const B = { project: "/r/.git", id: "W2", blocked_by: ["W1"] };
		const P = { project: "/r/.git", id: "W9", waiting_on: ["W9.1"] };
		const C = { project: "/r/.git", id: "W9.1" };
		const H = { project: "/r/.git", id: "W5", blocked_by: ["W1"] };
		const vis: Record<string, number> = {};
		for (const t of [A, B, P, C]) vis[tkeyOf(t)] = 1;
		const edges = splineEdges([A, B, P, C, H], vis);
		expect(edges).toContainEqual({
			cls: "spl-block",
			from: tkeyOf(A),
			to: tkeyOf(B),
		});
		expect(edges).toContainEqual({
			cls: "spl-wait",
			from: tkeyOf(C),
			to: tkeyOf(P),
		});
		for (const e of edges) {
			expect(e.to).not.toBe(tkeyOf(H));
		}
	});

	test("page CSS: spline strokes ride theme tokens; legend rendered", () => {
		expect(HTML).toContain(
			"#ksplines > path.spl-block { stroke:var(--klh-danger-ink); }",
		);
		expect(HTML).toContain(
			"#ksplines > path.spl-wait { stroke:var(--klh-ok-ink); }",
		);
		expect(HTML).toContain('id="splinesLegend"');
	});
});
