import { expect, test } from "bun:test";
import { TASKS } from "../hooks/board-html/tasks.ts";

const { displayState, taskBucket, kanbanFamilies, KCOLS } = new Function(
	"window",
	`${TASKS}; return {displayState,taskBucket,kanbanFamilies,KCOLS};`,
)({ addEventListener() {} });

test("canonical paused execution has exactly one display group without mutating the work state", () => {
	const claim = {
		project: "p",
		id: "W1",
		state: "CLAIMED",
		execution: { state: "paused" },
	};
	expect(displayState(claim)).toBe("PAUSED");
	expect(taskBucket(claim)).toBe("paused");
	expect(
		KCOLS.filter((c: { states: string[] }) =>
			c.states.includes(displayState(claim)),
		).map((c: { key: string }) => c.key),
	).toEqual(["PAUSED"]);
	expect(claim.state).toBe("CLAIMED");
	expect(displayState({ ...claim, state: "DONE" })).toBe("DONE");
	for (const state of ["live-harness", "unknown", "dead", "transitioning"]) {
		expect(displayState({ ...claim, execution: { state } })).toBe("CLAIMED");
	}
});
test("paused child escapes shattered family exactly once and resume restores the family", () => {
	const parent = { project: "p", id: "W1", state: "SHATTERED" };
	const child = {
		project: "p",
		id: "W1.1",
		state: "CLAIMED",
		execution: { state: "paused" },
	};
	expect(kanbanFamilies([parent, child]).nested[child.id]).toBeUndefined();
	expect(
		kanbanFamilies([parent, { ...child, execution: { state: "live-harness" } }])
			.nested[child.id].a,
	).toBe(parent.id);
});
