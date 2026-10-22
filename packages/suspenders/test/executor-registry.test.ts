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
import {
	CLAUDE_ALLOWED_TOOLS,
	workerManagedArgs,
} from "../hooks/lib/executors/claude.ts";
import { DEFAULT_ALLOWED_TOOLS, executorLaunch } from "../scripts/lib/lane.ts";

describe("W422 executor-adapter registry", () => {
	test("managed launch is adapter data and preserves the native executable separately", () => {
		const selected = executorLaunch(adapterFor("claude"), "/native/claude");
		expect(selected.bin.endsWith("/hooks/bin/claude-runtime.ts")).toBe(true);
		expect(selected.env).toEqual({
			SUSPENDERS_CLAUDE_NATIVE_BIN: "/native/claude",
		});
		const plain = executorLaunch(adapterFor("copilot"), "/native/copilot");
		expect(plain).toEqual({ bin: "/native/copilot", env: {} });
	});

	test("one row per agent; lane.ts re-export = claude recipe", () => {
		expect(EXECUTOR_ADAPTERS.map((a) => a.id)).toEqual([
			"claude",
			"codex",
			"forge",
			"copilot",
			"grok",
			"cline",
		]);
		expect(HARNESS_PROCESS_NAMES).toEqual([
			"claude",
			"claude-runtime.ts",
			"codex",
			"forge",
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
		// W918.3: copilot resume verified live on 1.0.98 — --session-id
		// appends in place (no --fork-session; retake fence stays claude-only).
		expect(adapterForExact("copilot")?.forkArgs("s1")).toEqual([
			"--session-id",
			"s1",
		]);
		for (const h of ["forge", "codex", "grok", "cline", "gemini"]) {
			expect(adapterForExact(h)?.forkArgs("s1") ?? null).toBeNull();
		}
		expect(adapterForExact("no-such-agent")).toBeNull();
	});
	test("starter seed grammar is adapter data — only claude carries it (W918.3)", () => {
		expect(adapterForExact("claude")?.starterSeedArgs?.("<seed>")).toEqual([
			// W1124.12: the seed rides the managed worker profile first.
			...workerManagedArgs(),
			"-p",
			"<seed>",
			"--output-format",
			"json",
			"--max-turns",
			"1",
		]);
		for (const h of ["copilot", "codex", "forge", "grok", "cline"]) {
			expect(adapterForExact(h)?.starterSeedArgs).toBeUndefined();
		}
	});
	test("isSpawnableExecutor gates resolveLaneExecutor; forge/grok/cline catalog-only", () => {
		expect(isSpawnableExecutor("claude")).toBe(true);
		expect(isSpawnableExecutor("copilot")).toBe(true);
		expect(isSpawnableExecutor("codex")).toBe(true);
		expect(isSpawnableExecutor("forge")).toBe(false);
		expect(isSpawnableExecutor("grok")).toBe(false);
		expect(isSpawnableExecutor("cline")).toBe(false);
		expect(isSpawnableExecutor("glm-5.3-flash")).toBe(false);
	});
	test("copilot adapter: W223.1 tail + W223.2 hard brief gate", () => {
		const copilot = adapterFor("copilot");
		expect(copilot.briefHardGate).toBe(true);
		expect(copilot.spawnArgs({})).toEqual([
			"--allow-all-tools",
			"--disable-builtin-mcps",
		]);
		expect(copilot.spawnArgs({ forkArgs: ["--session-id", "s9"] })).toEqual([
			"--allow-all-tools",
			"--disable-builtin-mcps",
			"--session-id",
			"s9",
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
			...workerManagedArgs(),
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

// W1121 noninteractive CLI permission policy: every Bash row is a PREFIX
// rule (trailing `:*`), the governed closure verbs ride the recipe, and no
// row names an absolute path. A headless lane runs `work done --sha` to
// close its own item; a bare exact rule (the old `Bash(diff)`) rejects
// every invocation that carries arguments.
describe("W1121 claude lane permission recipe", () => {
	const bashRules = CLAUDE_ALLOWED_TOOLS.split(" ").filter((r) =>
		r.startsWith("Bash("),
	);

	test("every Bash rule is a trailing-wildcard prefix rule", () => {
		for (const rule of bashRules) {
			expect(rule.endsWith(":*)")).toBe(true);
		}
	});

	test("closure + quality + stream verbs ride the recipe", () => {
		const rules = new Set(bashRules);
		for (const verb of [
			"work",
			"coord",
			"oracle",
			"git",
			"bun",
			"qlty",
			"rg",
			"eza",
			"sd",
			"sed",
			"diff",
			"head",
			"tail",
			"wc",
			"stat",
			"find",
			"grep",
			"cat",
		]) {
			expect(rules.has(`Bash(${verb}:*)`)).toBe(true);
		}
	});

	test("no rule pins an absolute or home path (canonical verbs only)", () => {
		for (const rule of bashRules) {
			expect(rule.startsWith("Bash(/")).toBe(false);
			expect(rule.startsWith("Bash(~")).toBe(false);
		}
	});

	test("Edit/Write stay allowed; no bare unprefixed Bash grant", () => {
		const rows = CLAUDE_ALLOWED_TOOLS.split(" ");
		expect(rows).toContain("Edit");
		expect(rows).toContain("Write");
		expect(rows.filter((r) => r === "Bash")).toEqual([]);
	});
});
