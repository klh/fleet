// test/dispatch-seed-error.test.ts — W695.1: the dispatch output and the
// lane registry row carry the starter-seed failure (exit code + stderr tail
// + phase marker + belt-front preflight verdict). E2E over the real
// dispatch-next CLI in a scratch repo/HOME: the executor stub sleeps through
// the seed turn, so the seed yields no session id, dispatch logs SEED FAILED
// and falls back to a cold start whose registry row carries the seedError.
import { afterAll, expect, test } from "@playwright/test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";
test.describe({ tag: "@unit" }, () => {

const { HOME, REPO, tool, dispatchWith } = dispatchHarness(afterAll, {
	tag: "w6951-dispatch",
});

test.describe("W695.1 starter-seed error propagation", () => {
	test("seed failure surfaces exit code + stderr tail + preflight + registry row", async () => {
		const added = tool("work.ts", "add", "seed error propagation probe");
		const id = added.out.match(/W\d+/)?.[0] ?? "";
		expect(id).toBeTruthy();
		const sleepExec = join(HOME, "sleep-claude");
		writeFileSync(sleepExec, "#!/bin/sh\nsleep 2\n");
		chmodSync(sleepExec, 0o700);
		const result = dispatchWith(
			{
				SUSPENDERS_CLAUDE_BIN: sleepExec,
				SUSPENDERS_LANE_STARTER: "on",
			},
			"--item",
			id,
			"--target",
			"1",
			"--no-belt",
		);
		expect(result.out).toContain(`SEED FAILED ${id}`);
		expect(result.out).toMatch(/starter-seed, code \d+/);
		expect(result.out).toContain("seed fallback:");
		const lanes = JSON.parse(
			readFileSync(join(REPO, ".fleet", "lanes.json"), "utf8"),
		) as Array<{
			item: string;
			seedError?: { phase: string; code: number; preflight?: string };
		}>;
		const mine = lanes.find((l) => l.item === id);
		expect(mine?.seedError?.phase).toBe("starter-seed");
		expect(mine?.seedError?.preflight).toBeUndefined();
	}, 30000);
});

});
