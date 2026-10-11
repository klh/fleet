// test/executor-registry.test.ts — W422 surface consolidation law: the
// executor-adapter registry is the ONLY home of executor specifics in core
// dispatch. One file per agent under hooks/lib/executors/, one row per
// agent in EXECUTOR_ADAPTERS; core files carry zero executor branches.
import { describe, expect, test } from "bun:test";
import {
	EXECUTOR_ADAPTERS,
	HARNESS_PROCESS_NAMES,
	adapterFor,
	adapterForExact,
	isSpawnableExecutor,
} from "../hooks/lib/executors/registry.ts";
import { CLAUDE_ALLOWED_TOOLS } from "../hooks/lib/executors/claude.ts";
import { DEFAULT_ALLOWED_TOOLS } from "../scripts/lib/lane.ts";

describe("W422 executor-adapter registry", () => {
	test("one row per agent; lane.ts re-export = claude recipe", () => {
		expect(EXECUTOR_ADAPTERS.map((a) => a.id)).toEqual([
			"claude",
			"codex",
			"copilot",
			"grok",
			"cline",
		]);
		expect(HARNESS_PROCESS_NAMES).toEqual([
			"claude",
			"codex",
			"copilot",
			"grok",
			"cline",
		]);
		expect(DEFAULT_ALLOWED_TOOLS).toBe(CLAUDE_ALLOWED_TOOLS);
	});
	test("adapterFor: token -> adapter; unknown = belt model pin riding claude", () => {
		expect(adapterFor("claude").bin).toBe("claude");
		expect(adapterFor("copilot").bin).toBe("copilot");
		expect(adapterFor("codex").bin).toBe("codex");
		expect(adapterFor("glm-5.3-flash").id).toBe("claude");
	});
	test("adapterForExact: no fallback — unknown harness cold-starts, never forks like claude", () => {
		expect(adapterForExact("claude")?.forkArgs("s1")).toEqual([
			"--resume",
			"s1",
			"--fork-session",
		]);
		for (const h of ["copilot", "codex", "grok", "cline", "gemini"]) {
			expect(adapterForExact(h)?.forkArgs("s1") ?? null).toBeNull();
		}
		expect(adapterForExact("no-such-agent")).toBeNull();
	});
	test("isSpawnableExecutor gates resolveLaneExecutor; grok/cline catalog-only", () => {
		expect(isSpawnableExecutor("claude")).toBe(true);
		expect(isSpawnableExecutor("copilot")).toBe(true);
		expect(isSpawnableExecutor("codex")).toBe(true);
		expect(isSpawnableExecutor("grok")).toBe(false);
		expect(isSpawnableExecutor("cline")).toBe(false);
		expect(isSpawnableExecutor("glm-5.3-flash")).toBe(false);
	});
	test("copilot adapter: W223.1 tail + W223.2 hard brief gate", () => {
		const copilot = adapterFor("copilot");
		expect(copilot.briefHardGate).toBe(true);
		// W422.21 folded fleet-loop's --allow-all-paths delta in — dispatch-next
		// and fleet-loop launch copilot identically now.
		expect(copilot.spawnArgs({})).toEqual([
			"--allow-all-tools",
			"--allow-all-paths",
		]);
		expect(copilot.promptArgs("m")).toEqual(["-p", "m"]);
	});
	test("codex adapter: exec subcommand carries the prompt LAST (W73)", () => {
		const codex = adapterFor("codex");
		expect(codex.promptArgs("m")).toEqual(["exec", "m"]);
		expect(codex.spawnArgs({})).toEqual(["--sandbox", "danger-full-access"]);
	});
	test("claude spawnArgs composes the full dispatch tail in order", () => {
		expect(
			adapterFor("claude").spawnArgs({
				fallbackModels: ["glm-flash2"],
				settingsArgs: ["--settings", "/x/y.json"],
				forkArgs: ["--resume", "s1", "--fork-session"],
			}),
		).toEqual([
			"--allowedTools",
			CLAUDE_ALLOWED_TOOLS,
			"--permission-mode",
			"acceptEdits",
			"--fallback-model",
			"glm-flash2",
			"--settings",
			"/x/y.json",
			"--resume",
			"s1",
			"--fork-session",
		]);
	});
});

describe("W422.21 direct-launch rows (fleet-loop rides the registry)", () => {
	const need = (id: string) => {
		const a = adapterForExact(id);
		if (!a) throw new Error(`no adapter row for ${id}`);
		return a;
	};
	test("one data row per agent: workspaces, git stores, dialects, identity", () => {
		expect(need("claude").workspace).toBe("git-worktree");
		expect(need("codex").workspace).toBe("plain-dir");
		expect(need("codex").privateGitStore).toBe(true);
		for (const id of ["claude", "copilot", "grok", "cline"]) {
			expect(need(id).privateGitStore).toBe(false);
		}
		// claude's hooks ride the global install — no dialect wire; the other
		// four each wire their own dialect
		expect(need("claude").wireDialect).toBeNull();
		for (const id of ["codex", "copilot", "grok", "cline"]) {
			expect(need(id).wireDialect).toBe(id);
		}
		// W73: codex rides SUSPENDERS_SID only — no protocol var
		expect(need("codex").identityProtocol).toBe(false);
		expect(need("codex").coordBootstrap).toBe(false);
		for (const id of ["claude", "copilot", "grok", "cline"]) {
			expect(need(id).identityProtocol).toBe(true);
			expect(need(id).coordBootstrap).toBe(true);
		}
	});
	test("launchArgs: codex prompt LAST, copilot effort passthrough, claude default tail", () => {
		expect(need("codex").launchArgs({ prompt: "m" })).toEqual([
			"exec",
			"--sandbox",
			"danger-full-access",
			"m",
		]);
		expect(need("copilot").launchArgs({ prompt: "m", effort: "high" })).toEqual(
			[
				"-p",
				"m",
				"--allow-all-tools",
				"--allow-all-paths",
				"--reasoning-effort",
				"high",
			],
		);
		expect(need("copilot").launchArgs({ prompt: "m" })).toEqual([
			"-p",
			"m",
			"--allow-all-tools",
			"--allow-all-paths",
		]);
		expect(need("claude").launchArgs({ prompt: "m" })).toEqual([
			"-p",
			"m",
			"--allowedTools",
			CLAUDE_ALLOWED_TOOLS,
			"--permission-mode",
			"acceptEdits",
		]);
	});
	test("initWorkspaceGit: only the private-store row carries the hook", () => {
		expect(typeof need("codex").initWorkspaceGit).toBe("function");
		for (const id of ["claude", "copilot", "grok", "cline"]) {
			expect(need(id).initWorkspaceGit).toBeNull();
		}
	});
});
