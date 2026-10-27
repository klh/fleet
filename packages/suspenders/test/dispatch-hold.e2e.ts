import { expect, test } from "./pw";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const { REPO, toolWith, dispatchWith } = dispatchHarness(test.afterAll, {
	tag: "dispatch-rollout-hold",
});

test("rollout hold keeps a READY item unclaimed and leaves existing lanes alone", () => {
	const item = toolWith({}, "work.ts", "add", "hold gate fixture").out.match(
		/W\d+/,
	)?.[0];
	if (!item) throw new Error("work add did not return an item id");
	const fleet = join(REPO, ".fleet");
	mkdirSync(fleet, { recursive: true });
	const marker = join(fleet, "dispatch-paused");
	writeFileSync(marker, "hub rollout\n");
	try {
		const result = dispatchWith({}, "--item", item, "--no-belt");
		expect(result.code).toBe(0);
		expect(result.out).toContain("WAIT — dispatch paused for rollout");
		const state = JSON.parse(
			toolWith({}, "work.ts", "show", item, "--json").out,
		);
		expect(state.state).toBe("READY");
	} finally {
		rmSync(marker, { force: true });
		toolWith({}, "work.ts", "fail", item);
	}
});
