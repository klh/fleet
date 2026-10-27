// test/dispatch-worker-profile.test.ts — W1124.12: a fresh dispatched lane's
// ACTUAL spawn argv rides the managed worker profile — strict MCP config
// with an explicit empty server map (no inherited MCP schemas) and the
// scoped built-in tool list. E2E over the real dispatch-next CLI: a capture
// stub replaces the executor and records every argv NUL-delimited —
// W1124.12.1: flattened `echo "$@"` is NOT boundary proof, so assertions
// read the per-argument array, never one joined string.
import { expect, test } from "./pw";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchHarness } from "./helpers/dispatch-harness.ts";
import { spawnClaude } from "../hooks/lib/lanes/lane.ts";
import { WORKER_MANAGED_PROFILE } from "../hooks/lib/executors/claude.ts";

// NUL-delimited capture: each argv element lands byte-exact, so the test
// can pin argument BOUNDARIES (empty args, embedded newlines, quotes).
const argvBody = `#!/bin/sh
for a in "$@"; do
  printf '%s\\0' "$a" >> "$HOME/claude-args.nul"
done
sleep 2
`;

const h = dispatchHarness(test.afterAll, {
	tag: "w1124-worker-profile",
	executorBody: argvBody,
});

test.describe("W1124.12 fresh worker rides the managed profile", () => {
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
		const argv = readFileSync(join(h.HOME, "claude-args.nul"), "utf8")
			.split("\0")
			.slice(0, -1);
		expect(argv).toContain("--strict-mcp-config");
		// boundary proof: the JSON arrives as ONE argument, byte-exact —
		// canonical compact form, never shell-stripped
		const mcpAt = argv.indexOf("--mcp-config");
		expect(mcpAt).toBeGreaterThanOrEqual(0);
		expect(argv[mcpAt + 1]).toBe(WORKER_MANAGED_PROFILE.mcpConfig);
		const toolsAt = argv.indexOf("--tools");
		expect(argv[toolsAt + 1]).toBe(WORKER_MANAGED_PROFILE.tools);
		// hooks stay live — never --bare, never a bypass
		expect(argv).not.toContain("--bare");
	}, 30000);
});

// W1124.12.1: the serializer quotes EVERY argument (not only space-bearing
// ones) — prove it at the spawn layer with the hostile charset the review
// flagged: apostrophe, dollar, parentheses, newline, empty arg, and a
// space-free JSON payload (the exact shape the old quoting mangled).
test.describe("W1124.12.1 spawnClaude argv fidelity", () => {
	test("every argument survives sh -c with boundaries intact", async () => {
		const dir = join(h.HOME, "argv-fidelity");
		mkdirSync(dir, { recursive: true });
		const stub = join(dir, "capture.sh");
		writeFileSync(stub, argvBody);
		chmodSync(stub, 0o700);
		const proc = spawnClaude({
			bin: stub,
			prompt: "it's $HOME (x)\nline2",
			cwd: dir,
			logFile: join(dir, "lane.log"),
			env: { HOME: dir, PATH: "/usr/bin:/bin" },
			cliArgs: ["", "a b", '{"k":"v"}'],
		});
		await proc.exited;
		const argv = readFileSync(join(dir, "claude-args.nul"), "utf8")
			.split("\0")
			.slice(0, -1);
		expect(argv).toEqual([
			"-p",
			"it's $HOME (x)\nline2",
			"",
			"a b",
			'{"k":"v"}',
		]);
	}, 20000);
});
