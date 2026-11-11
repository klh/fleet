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

test("durable spec pins the W2971 fence laws and refuses anthropic ids @unit", () => {
	const spec = buildRunSpec(parseArgs(ARGS));
	expect(spec).toMatchObject({
		wire: "openai-completions",
		maxRetries: 0,
		maxTokens: 2048,
		turnLimit: 12,
		effort: { requested: "low", effective: null },
	});
	expect(() =>
		buildRunSpec(parseArgs(["--worktree", "/w", "--model", "anthropic/claude-x", "--prompt", "p"])),
	).toThrow(/fence/);
});

test("usage line is parsed by the paired harness contract @unit", () => {
	const line = usageLine([
		{ exit: 0, timedOut: false, tokens: 100, cacheReadTokens: 5, cacheWriteTokens: 7 },
	]);
	const parsed = usageFromOutput(line);
	expect(parsed).toMatchObject({ tokens: 100, cacheReadTokens: 5, cacheWriteTokens: 7 });
	const missing = usageFromOutput(
		usageLine([{ exit: 0, timedOut: false, tokens: null, cacheReadTokens: null, cacheWriteTokens: null }]),
	);
	expect(missing).toBeNull();
});

test("executor refuses to fabricate attempts until the durable host lands @unit", async () => {
	const { code } = await runExecutor(ARGS, undefined, {
		BLAM_PI_DURABLE_URL: "https://testbed.local",
		BLAM_PI_DURABLE_TOKEN: "bksk_test",
	});
	expect(code).toBe(3);
	const missingEnv = await runExecutor(ARGS, undefined, {});
	expect(missingEnv.code).toBe(2);
	const badFence = await runExecutor(
		["--worktree", "/w", "--model", "claude-alias", "--prompt", "p"],
		undefined,
		{ BLAM_PI_DURABLE_URL: "https://t.local", BLAM_PI_DURABLE_TOKEN: "bksk_t" },
	);
	expect(badFence.code).toBe(2);
});

test("a completed driver run exits 0 and a failed leg exits 1 @unit", async () => {
	const ok = await runExecutor(ARGS, async () => ({
		exit: 0,
		timedOut: false,
		tokens: 42,
		cacheReadTokens: 1,
		cacheWriteTokens: 2,
	}), { BLAM_PI_DURABLE_URL: "https://t.local", BLAM_PI_DURABLE_TOKEN: "bksk_t" });
	expect(ok.code).toBe(0);
	const failed = await runExecutor(ARGS, async () => ({
		exit: 0,
		timedOut: false,
		tokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
	}), { BLAM_PI_DURABLE_URL: "https://t.local", BLAM_PI_DURABLE_TOKEN: "bksk_t" });
	expect(failed.code).toBe(1);
});

