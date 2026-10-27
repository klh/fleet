// The lanes board keeps dependency order and names split children on cards.
import { expect, test } from "@playwright/test";
import { TASKS } from "../hooks/board-html/tasks.ts";
import { HTML } from "../hooks/bin/fleet-board-html.ts";

type Item = Record<string, unknown>;

function chunkSandbox(): {
	tkey: (item: Item) => string;
	depOrder: (items: Item[]) => Item[];
} {
	const fn = new Function("window", `${TASKS}\nreturn { tkey, depOrder };`);
	return fn({ addEventListener: () => {} });
}

test.describe("board dependency presentation", () => {
	test("composite project and item keys keep projects separate", () => {
		const { tkey } = chunkSandbox();
		expect(tkey({ project: "/p1/.git", id: "W1" })).not.toBe(
			tkey({ project: "/p2/.git", id: "W1" }),
		);
	});

	test("providers precede dependents without losing cycles", () => {
		const { depOrder } = chunkSandbox();
		const A = { project: "/r/.git", id: "A", age_s: 3 };
		const B = { project: "/r/.git", id: "B", blocked_by: ["A"], age_s: 2 };
		const C = { project: "/r/.git", id: "C", blocked_by: ["B"], age_s: 1 };
		expect(depOrder([C, B, A]).map((item) => item.id)).toEqual(["A", "B", "C"]);
		const X = { project: "/r/.git", id: "X", blocked_by: ["Y"] };
		const Y = { project: "/r/.git", id: "Y", blocked_by: ["X"] };
		expect(
			depOrder([X, Y])
				.map((item) => item.id)
				.sort(),
		).toEqual(["X", "Y"]);
	});

	test("dependency details stay on cards without a connector overlay", () => {
		expect(TASKS).toContain("split into ' + esc(t.waiting_on.join(', '))");
		expect(TASKS).toContain("waiting on ' + esc(t.blocked_by.join(', '))");
		expect(HTML).not.toContain('id="splinesLegend"');
		expect(HTML).not.toContain("#ksplines");
	});
});
