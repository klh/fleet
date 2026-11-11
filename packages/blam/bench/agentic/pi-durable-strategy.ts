#!/usr/bin/env bun
/**
 * pi-durable executor for the paired live harness (W2971).
 *
 * Drop-in replacement for bench/agentic/strategy.ts's `codex exec` arm: same
 * argv contract (`--worktree/--model/--prompt`), same stdout contract (one
 * JSON line whose `usage` object `usageFromOutput` parses — see
 * bench/paired/live.ts), same exit semantics (0 = completed attempt).
 *
 * The treatment rides the official @earendil-works/pi-durable runner under
 * the W2971 wire law: openai-completions only, retries disabled (0), a hard
 * 2048-token generation ceiling and a 12-turn ceiling — the durable guest
 * must never silently retry or escalate.
 *
 * The durable runtime host is the next W2971 commit; until it lands the
 * executor refuses to fabricate an attempt (exit 3 + a loud DRY banner) so
 * a half-wired arm can never produce an accepted receipt.
 */

export const WIRE = "openai-completions" as const;
export const MAX_RETRIES = 0;
export const MAX_TOKENS = 2048;
export const TURN_LIMIT = 12;

export type ExecutorArgs = {
	/** Absolute path of the prepared worktree the attempt runs in. */
	readonly worktree: string;
	/** Model route id, passed through verbatim (3-layer pin seam). */
	readonly model: string;
	/** The full case prompt; never truncated by the executor. */
	readonly prompt: string;
	/** Requested effort level; the provider's effective level is recorded separately. */
	readonly effort: string;
};

export type DurableRunSpec = {
	readonly wire: typeof WIRE;
	readonly model: string;
	readonly maxRetries: typeof MAX_RETRIES;
	readonly maxTokens: typeof MAX_TOKENS;
	readonly turnLimit: typeof TURN_LIMIT;
	readonly effort: { readonly requested: string; readonly effective: null };
};

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
	env: { readonly baseUrl: string; readonly token: string },
) => Promise<AttemptResult>;

export class ExecutorError extends Error {
	constructor(
		readonly usage: string,
		options?: { cause?: unknown },
	) {
		super(usage, options);
	}
}

const REQUIRED = ["--worktree", "--model", "--prompt"] as const;

/** Parse the argv contract shared with bench/agentic/strategy.ts. */
export function parseArgs(argv: readonly string[]): ExecutorArgs {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!flag?.startsWith("--") || value === undefined)
			throw new ExecutorError(`expected --flag value pairs, got: ${argv.join(" ")}`);
		if (flags.has(flag)) throw new ExecutorError(`duplicate flag ${flag}`);
		flags.set(flag, value);
	}
	for (const flag of REQUIRED)
		if (!flags.get(flag)) throw new ExecutorError(`missing required ${flag}`);
	return {
		worktree: flags.get("--worktree") ?? "",
		model: flags.get("--model") ?? "",
		prompt: flags.get("--prompt") ?? "",
		effort: flags.get("--effort") ?? "low",
	};
}

/**
 * Build the durable run spec under the W2971 fence laws. Refuses models the
 * fence forbids: the durable wire is openai-completions only, so Anthropic
 * ids (which ride the /v1/messages dialect) never enter a guest spec.
 */
export function buildRunSpec(args: ExecutorArgs): DurableRunSpec {
	if (/^anthropic\//i.test(args.model) || /^claude/i.test(args.model))
		throw new ExecutorError(
			`fence: ${args.model} rides the anthropic wire; the durable runner speaks ${WIRE} only`,
		);
	return {
		wire: WIRE,
		model: args.model,
		maxRetries: MAX_RETRIES,
		maxTokens: MAX_TOKENS,
		turnLimit: TURN_LIMIT,
		effort: { requested: args.effort, effective: null },
	};
}

/**
 * The default driver refuses to fabricate: no durable runtime host has
 * landed yet, and a silent zero-usage success would pollute receipts.
 */
export const dryDriver: SessionDriver = async () => {
	throw new ExecutorError("live arm not landed (W2971 next commit)");
};

/**
 * Emit the one-line JSON summary `usageFromOutput` accepts. Totals are
 * summed only when EVERY leg reported usage — a missing leg stays null
 * (unreported), never coerced to zero.
 */
export function usageLine(
	results: readonly AttemptResult[],
	extra: Record<string, unknown> = {},
): string {
	const sum = (key: "tokens" | "cacheReadTokens" | "cacheWriteTokens") =>
		results.every((r) => r[key] !== null)
			? results.reduce((n, r) => n + (r[key] ?? 0), 0)
			: null;
	return JSON.stringify({
		usage: {
			total_tokens: sum("tokens"),
			cached_input_tokens: sum("cacheReadTokens"),
			cache_write_input_tokens: sum("cacheWriteTokens"),
		},
		executor: "pi-durable",
		agents: results.length,
		...extra,
	});
}

export async function runExecutor(
	argv: readonly string[],
	driver: SessionDriver = dryDriver,
	env: Record<string, string | undefined> = process.env,
): Promise<{ code: number }> {
	let args: ExecutorArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`pi-durable-strategy: ${(error as Error).message}`);
		return { code: 2 };
	}
	let spec: DurableRunSpec;
	try {
		spec = buildRunSpec(args);
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
	try {
		const result = await driver(spec, args, { baseUrl, token });
		console.log(usageLine([result], { worktree: args.worktree, mode: "solo" }));
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
