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
import { codexRideArgs } from "../hooks/lib/executors/codex.ts";
import { laneRideOf } from "../scripts/lib/lane-ride.ts";
import { servesWire, wirePick } from "../scripts/lib/lane-wire.ts";
import {
	DEFAULT_ALLOWED_TOOLS,
	executorLaunch,
} from "../hooks/lib/lanes/lane.ts";

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
			"cd",
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

// W1712: executor ↔ model wire compatibility (mocked endpoint unions — the
// live capability join is W1711's; unknown never refuses or re-selects).
describe("W1712 wire-aware executor selection", () => {
	const RESPONSES_ONLY = async () => ["/v1/responses"];
	const CHAT_ONLY = async () => ["/v1/chat/completions"];
	const UNKNOWN = async () => null;

	test("adapters declare the wire their CLI speaks", () => {
		expect(adapterForExact("claude")?.wire).toBe("messages");
		expect(adapterForExact("codex")?.wire).toBe("responses");
		expect(adapterForExact("copilot")?.wire).toBe("chat");
	});

	test("servesWire: Buckle bridges messages↔chat, never into responses", () => {
		expect(servesWire(["/v1/chat/completions"], "messages")).toBe(true);
		expect(servesWire(["/v1/messages"], "chat")).toBe(true);
		expect(servesWire(["/v1/responses"], "messages")).toBe(false);
		expect(servesWire(["/v1/responses"], "chat")).toBe(false);
		expect(servesWire(["/v1/chat/completions"], "responses")).toBe(false);
		expect(servesWire(["/v1/responses"], "responses")).toBe(true);
		expect(servesWire(null, "messages")).toBeNull();
	});

	test("a defaulted claude pin on a Responses-only model moves to codex, same model", async () => {
		const pick = { bin: "claude", model: "gpt-6.1-sol" };
		expect(await wirePick(pick, RESPONSES_ONLY, true)).toEqual({
			ok: true,
			bin: "codex",
			switched: true,
		});
	});

	test("an explicit executor+model pairing refuses instead of re-selecting", async () => {
		const r = await wirePick(
			{ bin: "claude", model: "grok-4.7" },
			RESPONSES_ONLY,
			false,
		);
		expect(r.ok).toBe(false);
		if (!r.ok)
			expect(r.why).toContain(
				"claude speaks /v1/messages but grok-4.7 serves /v1/responses",
			);
	});

	test("no provable carrier refuses; served, unknown or unpinned keeps the pick", async () => {
		const none = await wirePick(
			{ bin: "codex", model: "m" },
			async () => [],
			true,
		);
		expect(none.ok).toBe(false);
		const keep = { ok: true, bin: "claude", switched: false };
		expect(
			await wirePick(
				{ bin: "claude", model: "gemini-4-argon" },
				CHAT_ONLY,
				true,
			),
		).toEqual(keep);
		expect(
			await wirePick({ bin: "claude", model: "gpt-6.1-sol" }, UNKNOWN, true),
		).toEqual(keep);
		expect(
			await wirePick({ bin: "claude", model: null }, RESPONSES_ONLY, true),
		).toEqual(keep);
	});

	const LANE_ENV = {
		OPENAI_BASE_URL: "http://front.test/w/lane-x/v1",
		ANTHROPIC_AUTH_TOKEN: "lane-key-fixture",
	};

	test("codex rides the exact pin on the lane's own Buckle responses provider", () => {
		const r = laneRideOf(LANE_ENV, "gpt-6.1-sol", "low");
		if (!r.ok) throw new Error(r.why);
		const argv = codexRideArgs(r.ride);
		expect(argv).toEqual([
			...["-c", 'model="gpt-6.1-sol"', "-c", 'model_provider="buckle_lane"'],
			...["-c", 'model_providers.buckle_lane.name="buckle lane"'],
			...[
				"-c",
				'model_providers.buckle_lane.base_url="http://front.test/w/lane-x/v1"',
			],
			...["-c", 'model_providers.buckle_lane.env_key="ANTHROPIC_AUTH_TOKEN"'],
			...["-c", 'model_providers.buckle_lane.wire_api="responses"'],
			...["-c", 'model_reasoning_effort="low"'],
		]);
		expect(argv.join(" ")).not.toContain("lane-key-fixture");
		expect(adapterForExact("codex")?.modelArgs).toBe(codexRideArgs);
		expect(adapterForExact("claude")?.modelArgs).toBeUndefined();
	});

	test("laneRideOf refuses a personal-seat substitution or an unsafe model id", () => {
		const seat = { ...LANE_ENV, OPENAI_BASE_URL: "http://seat.test/v1" };
		expect(laneRideOf(seat, "m", "low").ok).toBe(false);
		expect(
			laneRideOf({ ...LANE_ENV, ANTHROPIC_AUTH_TOKEN: "" }, "m", "low").ok,
		).toBe(false);
		expect(laneRideOf(LANE_ENV, 'm" model_provider="x', "low").ok).toBe(false);
	});
});
