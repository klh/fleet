// test/dispatch-starter-fork.test.ts — W768: the starter fork actually rides
// the dispatch spawn. E2E over the real dispatch-next CLI: a capture stub
// replaces the executor, records every argv line, and answers the seed turn
// with a session id — the lane spawn must carry --resume <id> --fork-session.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";

const h = dispatchHarness(test.afterAll, {
	tag: "w768-starter-fork",
	executorBody: `#!/bin/sh
echo "$@" >> "$HOME/claude-args.log"
echo '{"session_id":"seed-stub-w768","type":"result"}'
sleep 2
`,
});

test.describe("W768 starter fork rides the dispatch spawn", () => {
	test("lane spawn carries --resume <seed-id> --fork-session", async () => {
		const id = await h.addItem("starter fork spawn probe");
		const result = await h.dispatchWith(
			{ SUSPENDERS_LANE_STARTER: "on" },
			"--item",
			id,
			"--target",
			"1",
			"--no-belt",
		);
		expect(result.out).toContain(`dispatched ${id}`);
		// the STARTER/forked line rides the lanes log, not stdout — the spawn
		// args are the ground truth for "the fork actually rode".
		const argsLog = readFileSync(join(h.HOME, "claude-args.log"), "utf8");
		expect(argsLog).toContain("--resume seed-stub-w768 --fork-session");
	}, 30000);
});
