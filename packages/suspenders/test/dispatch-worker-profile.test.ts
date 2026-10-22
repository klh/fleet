// test/dispatch-worker-profile.test.ts — W1124.12: a fresh dispatched lane's
// ACTUAL spawn argv rides the managed worker profile — strict MCP config
// with an explicit empty server map (no inherited MCP schemas) and the
// scoped built-in tool list. E2E over the real dispatch-next CLI: a capture
// stub replaces the executor and records every argv line.
import { describe, expect, test, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";
import { WORKER_MANAGED_PROFILE } from "../hooks/lib/executors/claude.ts";

const h = dispatchHarness(afterAll, {
	tag: "w1124-worker-profile",
	executorBody: `#!/bin/sh
echo "$@" >> "$HOME/claude-args.log"
sleep 2
`,
});

describe("W1124.12 fresh worker rides the managed profile", () => {
	test("lane spawn argv carries strict empty MCP + scoped tools", async () => {
		const id = await h.addItem("worker profile spawn probe");
		const result = await h.dispatchWith(
			{ SUSPENDERS_LANE_STARTER: "off" },
			"--item",
			id,
			"--target",
			"1",
			"--no-belt",
		);
		expect(result.out).toContain(`dispatched ${id}`);
		const argsLog = readFileSync(join(h.HOME, "claude-args.log"), "utf8");
		expect(argsLog).toContain("--strict-mcp-config");
		// the sh -c layer single-quotes args containing a space — the space
		// after the colon is load-bearing; assert the JSON survives the shell
		expect(argsLog).toContain(WORKER_MANAGED_PROFILE.mcpConfig);
		expect(argsLog).toContain(`--tools ${WORKER_MANAGED_PROFILE.tools}`);
		// hooks stay live — never --bare, never a bypass
		expect(argsLog).not.toContain("--bare");
	}, 30000);
});
