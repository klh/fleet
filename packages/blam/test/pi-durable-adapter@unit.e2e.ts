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

test("live runtime: route verification reads serving reality, not names", async () => {
	const { verifyRouteAdvertised } = await import(
		"../bench/agentic/pi-durable-runtime.ts"
	);
const listing = (ids: readonly string[]) =>
	new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
		status: 200,
	});
	expect(
		await verifyRouteAdvertised({
			baseUrl: "https://t.local",
			token: "bksk_t",
			model: "glm-5.3",
			fetchImpl: async () => listing(["glm-5.3"]),
		}),
	).toBe(true);
	expect(
		await verifyRouteAdvertised({
			baseUrl: "https://t.local",
			token: "bksk_t",
			model: "not-served",
			fetchImpl: async () => listing(["glm-5.3"]),
		}),
	).toBe(false);
	expect(
		await verifyRouteAdvertised({
			baseUrl: "https://t.local",
			token: "bksk_t",
			model: "glm-5.3",
			fetchImpl: async () => new Response("{}", { status: 503 }),
		}),
	).toBe(false);
});

test("live runtime: models carry exactly one openai-completions provider", async () => {
	const { buildModels } = await import(
		"../bench/agentic/pi-durable-runtime.ts"
	);
	const models = buildModels({
		baseUrl: "https://t.local",
		token: "bksk_t",
		model: "glm-5.3",
	});
	const all = models.getModels();
	expect(all).toHaveLength(1);
	expect(all[0]!.provider).toBe("blam-route");
	expect(all[0]!.api).toBe("openai-completions");
	expect(all[0]!.id).toBe("glm-5.3");
});

test("live runtime: durable session refuses without a journal root, env stays unlogged", async () => {
	const { runDurableSession } = await import(
		"../bench/agentic/pi-durable-runtime.ts"
	);
	const spec = {
		wire: "openai-completions",
		model: "glm-5.3",
		bounds: { maxTokens: null, turnLimit: null },
		effort: { requested: "low", effective: null },
		routeCompat: "unverified",
	} as const;
	const args = {
		worktree: "/tmp/wt",
		model: "glm-5.3",
		prompt: "hi",
		effort: "low",
		bounds: { maxTokens: null, turnLimit: null },
	};
	await expect(
		runDurableSession(spec, args, {
			baseUrl: "https://t.local",
			token: "bksk_t",
		}),
	).rejects.toThrow(/journal/);
});

test("live runtime: default driver still refuses; executor gates on env before the driver runs", async () => {
	const { runExecutor, dryDriver } = await import(
		"../bench/agentic/pi-durable-strategy.ts"
	);
	const refused = await runExecutor(
		["--worktree", "/tmp/wt", "--model", "m", "--prompt", "p"],
		dryDriver,
		{ BLAM_PI_DURABLE_URL: "https://t.local", BLAM_PI_DURABLE_TOKEN: "bksk_t" },
	);
	expect(refused.code).toBe(3);
	const envGated = await runExecutor(
		["--worktree", "/tmp/wt", "--model", "m", "--prompt", "p"],
		dryDriver,
		{ BLAM_PI_DURABLE_URL: "https://t.local" },
	);
	expect(envGated.code).toBe(2);
});
