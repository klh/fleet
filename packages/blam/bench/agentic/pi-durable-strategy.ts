#!/usr/bin/env bun
/**
 * pi-durable executor for the paired live harness (W2971).
 *
 * Drop-in replacement for bench/agentic/strategy.ts's `codex exec` arm: same
 * argv contract (`--worktree/--model/--prompt`), same stdout contract (one
 * JSON line whose `usage` object `usageFromOutput` parses — see
 * bench/paired/live.ts), same exit semantics (0 = completed attempt).
 *
 * Owner corrections folded in (plane events 122622/122625, C419):
 * - NO silent token/turn ceilings. Completion benchmarks run unbounded by
 *   default; finite wall-clock safety and scoped key TTL remain the only
 *   guards. Per-experiment bounds ride `--max-tokens`/`--turn-limit` ONLY
 *   when an experiment asks, and are receipt-recorded when set.
 * - Model names are not a capability check. A Buckle route may expose Claude
 *   ids over the openai-compatible wire; the executor never gates by name.
 *   Route compatibility is verified against the route's advertised
 *   offerings at runtime and receipt-recorded (spec carries the verdict).
 * - CLI argv and run-spec are wire boundaries: named Zod contracts, not
 *   hand-rolled parsing (schema law W1238.4).
 * - Empty or unreported legs stay null (unreported ≠ measured 0); a
 *   vacuous `every()` never reports 0.
 *
 * The durable runtime host is the next W2971 commit; until it lands the
 * executor refuses to fabricate an attempt (exit 3 + a loud DRY banner) so
 * a half-wired arm can never produce an accepted receipt.
 */

import { z } from "zod";

/** OpenAI-compatible completions wire — the only wire this executor speaks. */
export const WIRE = "openai-completions" as const;

/** Absolute path of the prepared worktree the attempt runs in. */
const WorktreeSchema = z
	.string()
	.min(1)
	.refine((value) => value.startsWith("/"), "worktree must be an absolute path");
const RouteIdSchema = z
	.string()
	.min(1)
	.describe("Model route id, passed through verbatim (no name-based gating)");
const PromptSchema = z
	.string()
	.min(1)
	.describe("The full case prompt; never truncated by the executor");
const EffortSchema = z
	.string()
	.min(1)
	.describe("Requested effort level; effective level is provider-recorded");
/** Optional per-experiment bounds — absent unless an experiment asks. */
const OptionalBoundSchema = z
	.number()
	.int()
	.positive()
	.nullable()
	.describe("Unbounded unless explicitly requested; receipt-recorded when set");

/** The executor argv contract, shared with the paired harness. */
export const ExecutorArgsSchema = z.strictObject({
	worktree: WorktreeSchema,
	model: RouteIdSchema,
	prompt: PromptSchema,
	effort: EffortSchema,
});
export type ExecutorArgs = z.infer<typeof ExecutorArgsSchema>;

/** Run spec handed to the durable runtime; limits only when requested. */
export const DurableRunSpecSchema = z.strictObject({
	wire: z.literal(WIRE),
	model: RouteIdSchema,
	bounds: z.strictObject({
		maxTokens: OptionalBoundSchema,
		turnLimit: OptionalBoundSchema,
	}),
	effort: z.strictObject({
		requested: EffortSchema,
		effective: z.null(),
	}),
	/** Verdict of the runtime check against the route's advertised offerings. */
	routeCompat: z.enum(["advertised", "unverified"]),
});
export type DurableRunSpec = z.infer<typeof DurableRunSpecSchema>;

export type AttemptResult = {
	readonly exit: number;
	readonly timedOut: boolean;
	readonly tokens: number | null;
	readonly cacheReadTokens: number | null;
	readonly cacheWriteTokens: number | null;
};

/** A durable session driver — the W2971 live arm injects the real runner. */
export type SessionDriver = (
	spec: DurableRunSpec,
	args: ExecutorArgs,
	env: {
		readonly baseUrl: string;
		readonly token: string;
		/** Host directory for the durable JSONL journal (never an image layer). */
		readonly journalRoot?: string;
		/** Optional wall-clock deadline in ms; absent = unbounded (no silent ceilings). */
		readonly deadlineMs?: number;
	},
) => Promise<AttemptResult>;

export class ExecutorError extends Error {
	constructor(
		readonly usage: string,
		options?: { cause?: unknown },
	) {
		super(usage, options);
	}
}

const FLAG_MAP: Record<string, keyof z.infer<typeof ExecutorArgsSchema>> = {
	"--worktree": "worktree",
	"--model": "model",
	"--prompt": "prompt",
	"--effort": "effort",
};
const REQUIRED_FLAGS = ["--worktree", "--model", "--prompt"] as const;
const BOUND_MAP: Record<string, "maxTokens" | "turnLimit"> = {
	"--max-tokens": "maxTokens",
	"--turn-limit": "turnLimit",
};

/**
 * Parse the argv contract through the named Zod schema (never hand-cast).
 * Bounds flags are optional and default to ABSENT — no silent ceilings.
 */
export function parseArgs(argv: readonly string[]): ExecutorArgs & {
	bounds: { maxTokens: number | null; turnLimit: number | null };
} {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!flag?.startsWith("--") || value === undefined)
			throw new ExecutorError(
				`expected --flag value pairs, got: ${argv.join(" ")}`,
			);
		if (flags.has(flag)) throw new ExecutorError(`duplicate flag ${flag}`);
		flags.set(flag, value);
	}
	const core: Record<string, unknown> = { effort: "low" };
	for (const [flag, key] of Object.entries(FLAG_MAP)) {
		const value = flags.get(flag);
		if (value === undefined) {
			if ((REQUIRED_FLAGS as readonly string[]).includes(flag))
				throw new ExecutorError(`missing required ${flag}`);
			continue;
		}
		core[key] = value;
	}
	const bounds: { maxTokens: number | null; turnLimit: number | null } = {
		maxTokens: null,
		turnLimit: null,
	};
	for (const [flag, key] of Object.entries(BOUND_MAP)) {
		const value = flags.get(flag);
		if (value === undefined) continue;
		const parsed = z.coerce
			.number()
			.int()
			.positive()
			.safeParse(value);
		if (!parsed.success)
			throw new ExecutorError(`${flag} must be a positive integer`);
		bounds[key] = parsed.data;
	}
	const args = ExecutorArgsSchema.safeParse(core);
	if (!args.success)
		throw new ExecutorError(
			`invalid executor args: ${args.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
		);
	return { ...args.data, bounds };
}

/**
 * Build the run spec from parsed args. No model-name gating: the wire is
 * fixed by this executor and compatibility with the route is a runtime
 * check against the route's advertisement (starts `unverified`; the live
 * arm flips it after verifying the route serves the requested model).
 */
export function buildRunSpec(
	args: ExecutorArgs & {
		bounds: { maxTokens: number | null; turnLimit: number | null };
	},
): DurableRunSpec {
	return {
		wire: WIRE,
		model: args.model,
		bounds: args.bounds,
		effort: { requested: args.effort, effective: null },
		routeCompat: "unverified",
	};
}

/**
 * The live driver: one durable pi-durable session over the host-owned JSONL
 * journal, riding the route named by BLAM_PI_DURABLE_URL. Import is lazy so
 * unit tests of the strategy itself never load the full harness graph.
 */
export const durableDriver: SessionDriver = async (spec, args, env) => {
	const { runDurableSession } = await import("./pi-durable-runtime.ts");
	return runDurableSession(
		spec,
		args,
		{
			baseUrl: env.baseUrl,
			token: env.token,
			BLAM_PI_DURABLE_ROOT: env.journalRoot,
			BLAM_PI_DURABLE_DEADLINE_MS:
				env.deadlineMs === undefined ? undefined : String(env.deadlineMs),
		},
	);
};

/**
 * The default driver still refuses to fabricate: callers must opt into the
 * live arm explicitly (a bench runner wires durableDriver itself), so a
 * bare `main` can never silently run a live session without the host-side
 * journal root it needs.
 */
export const dryDriver: SessionDriver = async () => {
	throw new ExecutorError(
		"no session driver wired — pass durableDriver from a host context with BLAM_PI_DURABLE_ROOT",
	);
};

/**
 * Emit the one-line JSON summary `usageFromOutput` accepts. Totals are
 * summed only when there is at least one leg and EVERY leg reported usage —
 * empty input and missing legs stay null (unreported), never coerced to 0.
 * `extra` is spread FIRST so the authoritative receipt fields can never be
 * overwritten by caller-supplied keys.
 */
export function usageLine(
	results: readonly AttemptResult[],
	extra: Record<string, unknown> = {},
): string {
	const sum = (key: "tokens" | "cacheReadTokens" | "cacheWriteTokens") =>
		results.length > 0 && results.every((r) => r[key] !== null)
			? results.reduce((n, r) => n + (r[key] ?? 0), 0)
			: null;
	return JSON.stringify({
		...extra,
		usage: {
			total_tokens: sum("tokens"),
			cached_input_tokens: sum("cacheReadTokens"),
			cache_write_input_tokens: sum("cacheWriteTokens"),
		},
		executor: "pi-durable",
		agents: results.length,
	});
}

export async function runExecutor(
	argv: readonly string[],
	driver: SessionDriver = dryDriver,
	env: Record<string, string | undefined> = process.env,
): Promise<{ code: number }> {
	let args: ExecutorArgs & {
		bounds: { maxTokens: number | null; turnLimit: number | null };
	};
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`pi-durable-strategy: ${(error as Error).message}`);
		return { code: 2 };
	}
	const baseUrl = env.BLAM_PI_DURABLE_URL ?? "";
	const token = env.BLAM_PI_DURABLE_TOKEN ?? "";
	if (!baseUrl || !token) {
		console.error(
			"pi-durable-strategy: BLAM_PI_DURABLE_URL and BLAM_PI_DURABLE_TOKEN must be set (token is read from env only, never logged)",
		);
		return { code: 2 };
	}
	const spec = buildRunSpec(args);
	try {
		const result = await driver(spec, args, {
			baseUrl,
			token,
			journalRoot: env.BLAM_PI_DURABLE_ROOT,
			deadlineMs: env.BLAM_PI_DURABLE_DEADLINE_MS
				? Number.parseInt(env.BLAM_PI_DURABLE_DEADLINE_MS, 10)
				: undefined,
		});
		console.log(
			usageLine([result], { worktree: args.worktree, mode: "solo" }),
		);
		return { code: result.exit === 0 && result.tokens !== null ? 0 : 1 };
	} catch (error) {
		console.error(
			`pi-durable-strategy: attempt did not run: ${(error as Error).message}`,
		);
		console.error("pi-durable-strategy: DRY — no fabricated attempt emitted");
		return { code: 3 };
	}
}

if (import.meta.main) {
	const { code } = await runExecutor(process.argv.slice(2));
	process.exit(code);
}
