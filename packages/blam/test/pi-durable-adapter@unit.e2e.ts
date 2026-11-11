import { expect, test } from "@playwright/test";
import {
	buildRunSpec,
	ExecutorError,
	parseArgs,
	runExecutor,
	usageLine,
} from "../bench/agentic/pi-durable-strategy.ts";
import { usageFromOutput } from "../bench/paired/live.ts";

const ARGS = [
	"--worktree",
	"/tmp/wt",
	"--model",
	"test-model",
	"--prompt",
	"fix the broken module",
];

test("pi-durable executor shares the strategy argv contract @unit", () => {
	expect(parseArgs(ARGS)).toMatchObject({
		worktree: "/tmp/wt",
		model: "test-model",
		prompt: "fix the broken module",
		effort: "low",
	});
	expect(() => parseArgs(["--model", "test-model"])).toThrow(ExecutorError);
	expect(() => parseArgs([...ARGS, "--worktree", "/other"])).toThrow(
		ExecutorError,
	);
});

test("bounds are absent unless explicitly requested; no silent ceilings @unit", () => {
	const unbounded = parseArgs(ARGS);
	expect(unbounded.bounds).toEqual({ maxTokens: null, turnLimit: null });
	const spec = buildRunSpec(unbounded);
	expect(spec.bounds).toEqual({ maxTokens: null, turnLimit: null });
	expect(spec.routeCompat).toBe("unverified");
	const bounded = parseArgs([...ARGS, "--max-tokens", "4096", "--turn-limit", "20"]);
	expect(bounded.bounds).toEqual({ maxTokens: 4096, turnLimit: 20 });
	expect(() => parseArgs([...ARGS, "--max-tokens", "0"])).toThrow(ExecutorError);
});

test("model names never gate capability (route verdict is runtime-recorded) @unit", () => {
	// Claude ids ride buckle routes over the openai-compatible wire; the
	// executor accepts any route id and records the runtime verdict instead.
	const claudeRoute = buildRunSpec(
		parseArgs(["--worktree", "/w", "--model", "claude-sonnet-5.5", "--prompt", "p"]),
	);
	expect(claudeRoute.model).toBe("claude-sonnet-5.5");
	expect(claudeRoute.wire).toBe("openai-completions");
});

test("usage line is parsed by the paired harness contract @unit", () => {
	const line = usageLine([
		{
			exit: 0,
			timedOut: false,
			tokens: 100,
			cacheReadTokens: 5,
			cacheWriteTokens: 7,
		},
	]);
	expect(usageFromOutput(line)).toMatchObject({
		tokens: 100,
		cacheReadTokens: 5,
		cacheWriteTokens: 7,
	});
	expect(
		usageFromOutput(
			usageLine([
				{
					exit: 0,
					timedOut: false,
					tokens: null,
					cacheReadTokens: null,
					cacheWriteTokens: null,
				},
			]),
		),
	).toBeNull();
});

test("empty attempts stay unreported, never 0; authoritative fields resist extra @unit", () => {
	const empty = JSON.parse(usageLine([])) as {
		usage: { total_tokens: number | null };
		executor: string;
		agents: number;
	};
	expect(empty.usage.total_tokens).toBeNull();
	expect(empty.agents).toBe(0);
	const overridden = JSON.parse(
		usageLine([], {
			usage: { total_tokens: 999999 },
			executor: "counterfeit",
			agents: 42,
		}),
	) as { usage: { total_tokens: number | null }; executor: string; agents: number };
	expect(overridden.usage.total_tokens).toBeNull();
	expect(overridden.executor).toBe("pi-durable");
	expect(overridden.agents).toBe(0);
});

test("executor refuses to fabricate attempts until the durable host lands @unit", async () => {
	const { code } = await runExecutor(ARGS, undefined, {
		BLAM_PI_DURABLE_URL: "https://testbed.local",
		BLAM_PI_DURABLE_TOKEN: "bksk_test",
	});
	expect(code).toBe(3);
	const missingEnv = await runExecutor(ARGS, undefined, {});
	expect(missingEnv.code).toBe(2);
	const badArgs = await runExecutor(
		["--worktree", "relative/path", "--model", "test-model", "--prompt", "p"],
		undefined,
		{ BLAM_PI_DURABLE_URL: "https://t.local", BLAM_PI_DURABLE_TOKEN: "bksk_t" },
	);
	expect(badArgs.code).toBe(2);
});

test("a completed driver run exits 0 and a failed leg exits 1 @unit", async () => {
	const ok = await runExecutor(
		ARGS,
		async () => ({
			exit: 0,
			timedOut: false,
			tokens: 42,
			cacheReadTokens: 1,
			cacheWriteTokens: 2,
		}),
		{ BLAM_PI_DURABLE_URL: "https://t.local", BLAM_PI_DURABLE_TOKEN: "bksk_t" },
	);
	expect(ok.code).toBe(0);
	const failed = await runExecutor(
		ARGS,
		async () => ({
			exit: 0,
			timedOut: false,
			tokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
		}),
		{ BLAM_PI_DURABLE_URL: "https://t.local", BLAM_PI_DURABLE_TOKEN: "bksk_t" },
	);
	expect(failed.code).toBe(1);
});
