// W1812.1 guard: board second-opinion bin resolution survives launchd's
// bare PATH. The W1812 consolidation replaced the hand-kept claude/codex
// ternary with the registry fallback (Bun.which, else the adapter
// installPaths probe), and the B1 review finding claimed the claude
// adapter lost its ~/.local/bin fallback because it declares no
// installPaths. It does declare them (the W626 row), so this pins the
// chain: under PATH=/usr/bin:/bin, which misses but the registry fallback
// still resolves the claude binary - second-opinion dispatch must never
// degrade to ok:false under a bare-PATH board process.
import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
	expandInstallPaths,
	isSpawnableExecutor,
} from "../hooks/lib/executors/registry.ts";

const BARE_PATH = "/usr/bin:/bin";

test("claude bin fallback resolves when which misses under a bare PATH", () => {
	// bun's which() reads its own env snapshot, so the bare PATH rides the
	// explicit option (the lane-liveness shape) instead of a process env
	// reassignment launchd's child board never does in-process
	expect(Bun.which("claude", { PATH: BARE_PATH })).toBeNull();

	expect(isSpawnableExecutor("claude")).toBe(true);
	const candidates = expandInstallPaths("claude");
	expect(candidates).toContain(`${process.env.HOME}/.local/bin/claude`);
	const bin = candidates.find((p) => existsSync(p));
	expect(bin, "claude binary not found via adapter installPaths").toBeTruthy();
	expect(bin !== undefined && existsSync(bin)).toBe(true);
});

test("codex rides the same chain - homebrew install is a registry fact", () => {
	expect(isSpawnableExecutor("codex")).toBe(true);
	expect(expandInstallPaths("codex")).toEqual(["/opt/homebrew/bin/codex"]);
});

test("a non-spawnable token never reaches bin resolution", () => {
	for (const token of ["forge", "grok", "cline", "glm-5.3-flash"]) {
		expect(isSpawnableExecutor(token)).toBe(false);
		expect(expandInstallPaths(token)).toEqual([]);
	}
});
