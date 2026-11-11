#!/usr/bin/env bun
/**
 * Live durable session host for the W2971 executor (host-side only).
 *
 * Wires the official @earendil-works/pi-durable@1.5.0 harness over a
 * host-owned JSONL journal (openNodeJsonlStorage — the durable journal never
 * bakes into an image layer; W2981.4 law), with pi-ai Models carrying exactly
 * one openai-completions provider pointed at the BLAM route.
 *
 * Owner laws kept here:
 * - Route capability is SERVING REALITY: the executor verifies the route's
 *   advertised /v1/models listing before submitting (W2677) and FAILS CLOSED
 *   on a miss (122898.3) — an unverified route never reaches a conversation.
 * - Model catalog numbers are the route's ADVERTISED metadata, never
 *   hardcoded guesses (122898.4); a route that advertises no context window
 *   or output limit is refused loudly instead of silently capped.
 * - No silent ceilings: the run is unbounded unless the caller passes an
 *   explicit wall-clock deadline (malformed deadline = usage error,
 *   122898.5); the durable conversation carries no token or turn caps of
 *   its own.
 * - Real tools: the official `coding-tools` extension (read/write/edit/bash)
 *   runs with the session env rooted at args.worktree (122898.1) — this is
 *   a coding executor, not a chat stub.
 * - Resume identity (122898.2): the durable conversation id is persisted in
 *   the journal root; `--resume` reopens THAT conversation in a fresh
 *   process — the SIGKILL-and-recover recipe is a first-class path.
 */

import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { TODO_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { z } from "zod";
import {
	type DurableRunSpec,
	type ExecutorArgs,
	type AttemptResult,
	ExecutorError,
	parseDeadlineMs,
} from "./pi-durable-strategy.ts";

const PROVIDER_ID = "blam-route";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Response | Promise<Response>;

/** The serving metadata a route must advertise before we submit. */
export type AdvertisedModel = {
	readonly id: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly reasoning?: boolean;
};

export type RouteVerdict =
	| { readonly advertised: true; readonly model: AdvertisedModel }
	| { readonly advertised: false };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const numberField = (record: Record<string, unknown>, keys: readonly string[]) => {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0)
			return value;
	}
	return undefined;
};

/** Verify the model against the route's advertised /v1/models listing. */
export async function verifyRoute(options: {
	baseUrl: string;
	token: string;
	model: string;
	fetchImpl?: FetchLike;
}): Promise<RouteVerdict> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const url = `${options.baseUrl.replace(/\/$/, "")}/v1/models`;
	const response = await fetchImpl(url, {
		headers: { authorization: `Bearer ${options.token}` },
	});
	if (!response.ok) return { advertised: false };
	const body = (await response.json()) as {
		data?: readonly unknown[];
	};
	const entry = (body.data ?? []).find(
		(candidate) =>
			isRecord(candidate) && candidate.id === options.model,
	);
	if (!isRecord(entry)) return { advertised: false };
	return {
		advertised: true,
		model: {
			id: options.model,
			contextWindow: numberField(entry, ["context_window", "contextWindow", "context_length"]),
			maxTokens: numberField(entry, ["max_output_tokens", "max_tokens", "maxTokens"]),
			reasoning:
				entry.reasoning === true ||
				typeof numberField(entry, ["reasoning_effort", "thinking_budget"]) ===
					"number",
		},
	};
}

/** The pi-ai thinking level the requested effort maps onto (schema law: zod). */
const ThinkingLevelSchema = z.enum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** Conversation ids are erased nominal integers; the library exports no constructor. */
const ConversationIdSchema = z.number().int().positive();

/**
 * One-provider Models whose only model rides the openai-completions wire.
 * Catalog numbers come from the route's advertisement — a route that does
 * not advertise them is a typed refusal, never a hardcoded guess.
 */
export function buildModels(options: {
	baseUrl: string;
	token: string;
	advertised: AdvertisedModel;
}): Models {
	const missing: string[] = [];
	if (options.advertised.contextWindow === undefined) missing.push("context_window");
	if (options.advertised.maxTokens === undefined) missing.push("max_output_tokens");
	if (missing.length > 0)
		throw new ExecutorError(
			`route advertisement for '${options.advertised.id}' is missing serving metadata: ${missing.join(", ")} — publish richer route metadata instead of guessing`,
			2,
		);
	const models = createModels();
	const provider = createProvider({
		id: PROVIDER_ID,
		baseUrl: options.baseUrl,
		auth: {
			apiKey: {
				name: "BLAM route key",
				resolve: async () => ({
					auth: { apiKey: options.token },
					source: "BLAM route key",
				}),
			},
		},
		models: [
			{
				id: options.advertised.id,
				name: options.advertised.id,
				api: "openai-completions",
				provider: PROVIDER_ID,
				baseUrl: options.baseUrl,
				input: ["text"],
				reasoning: options.advertised.reasoning === true,
				contextWindow: options.advertised.contextWindow!,
				maxTokens: options.advertised.maxTokens!,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		api: { "openai-completions": { stream, streamSimple } },
	});
	models.setProvider(provider);
	return models;
}

/** Resume identity file inside the host journal root. */
const RESUME_FILE = "last-conversation.json";

type WaitOutcome = "idle" | "timeout";

/**
 * Settle when the harness reports every ownerless conversation idle. No
 * deadline unless the caller supplies one — completion benchmarks run
 * unbounded; the deadline only converts into a `timeout` outcome.
 */
async function waitForSettle(
	harness: Harness,
	options: { deadlineMs?: number },
): Promise<WaitOutcome> {
	const idle = harness.waitForIdle(TODO_CONTEXT as Context);
	if (options.deadlineMs === undefined) {
		await idle;
		return "idle";
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<WaitOutcome>((resolve) => {
		timer = setTimeout(() => resolve("timeout"), options.deadlineMs);
	});
	const outcome = await Promise.race([
		idle.then((): WaitOutcome => "idle"),
		deadline,
	]);
	clearTimeout(timer);
	return outcome;
}

/** Cumulative usage totals from the durable ledger (null when nothing reported). */
export type UsageTotals = {
	readonly tokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
};

export function usageTotalsOf(usage: unknown): UsageTotals | null {
	let tokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let reported = false;
	const models = (usage as { models?: unknown } | null)?.models;
	if (!isRecord(models)) return null;
	for (const bucket of Object.values(models)) {
		const value = (bucket as { value?: unknown }).value;
		if (!isRecord(value)) continue;
		const input = typeof value.input === "number" ? value.input : 0;
		const output = typeof value.output === "number" ? value.output : 0;
		const read = typeof value.cacheRead === "number" ? value.cacheRead : 0;
		const write = typeof value.cacheWrite === "number" ? value.cacheWrite : 0;
		tokens += input + output;
		cacheRead += read;
		cacheWrite += write;
		reported = true;
	}
	return reported ? { tokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } : null;
}

/** Per-attempt DELTA (#123069): post − pre against the cumulative durable
 *  ledger. First legs (nothing reported before) count from zero; an attempt
 *  with no newly-reported legs stays null — unreported is never 0. */
export function usageDelta(
	before: UsageTotals | null,
	after: UsageTotals | null,
): UsageTotals | null {
	if (after === null) return null;
	if (before === null) return after;
	return {
		tokens: after.tokens - before.tokens,
		cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
		cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
	};
}

/**
 * Run one live attempt end-to-end: verify the route (fail closed), open the
 * durable journal + harness under `env.BLAM_PI_DURABLE_ROOT`, submit the
 * prompt to a coding-tools session rooted in the worktree, wait for settle,
 * and read usage from the durable ledger.
 */
export async function runDurableSession(
	spec: DurableRunSpec,
	args: ExecutorArgs,
	env: {
		readonly baseUrl: string;
		readonly token: string;
		readonly BLAM_PI_DURABLE_ROOT?: string;
		readonly BLAM_PI_DURABLE_DEADLINE_MS?: string;
	},
	fetchImpl?: FetchLike,
): Promise<AttemptResult> {
	if (!env.BLAM_PI_DURABLE_ROOT)
		throw new ExecutorError(
			"BLAM_PI_DURABLE_ROOT must name a host directory for the durable journal (never an image layer)",
		);
	const journalRoot = env.BLAM_PI_DURABLE_ROOT;
	const verdict = await verifyRoute({
		baseUrl: env.baseUrl,
		token: env.token,
		model: spec.model,
		fetchImpl,
	});
	// Fail closed (122898.3): an unverified route never opens a conversation.
	if (!verdict.advertised)
		throw new ExecutorError(
			`route does not advertise model '${spec.model}' — refusing to submit (fail-closed preflight)`,
			2,
		);
	const { openNodeJsonlStorage } = await import(
		"@earendil-works/pi-durable/storage/jsonl/node"
	);
	const storage = await openNodeJsonlStorage(
		journalRoot,
		TODO_CONTEXT as Context,
	);
	const deadline = parseDeadlineMs(env.BLAM_PI_DURABLE_DEADLINE_MS);
	if (!ThinkingLevelSchema.safeParse(args.effort).success)
		throw new ExecutorError(
			`effort '${args.effort}' is not a pi-ai thinking level (off|minimal|low|medium|high|xhigh|max)`,
			2,
		);
	const harness = await Harness.open(
		storage,
		{
			models: buildModels({ baseUrl: env.baseUrl, token: env.token, advertised: verdict.model }),
			registry: (() => {
				const registry = createRegistry();
				// Real coding tools (122898.1): read/write/edit/bash, rooted at the worktree.
				registry.install(createCodingTools());
				return registry;
			})(),
			env: () => new NodeExecutionEnv({ cwd: args.worktree }),
		},
		TODO_CONTEXT as Context,
	);
	try {
		let conversation: Awaited<ReturnType<Harness["createConversation"]>>;
		if (args.resume) {
			const resumePath = `${journalRoot}/${RESUME_FILE}`;
			const file = Bun.file(resumePath);
			if (!(await file.exists()))
				throw new ExecutorError(
					`--resume requested but ${resumePath} does not exist — no prior durable session in this journal`,
					2,
				);
			const parsed = JSON.parse(await file.text()) as { conversationId?: unknown };
			const idCheck = ConversationIdSchema.safeParse(parsed.conversationId);
			if (!idCheck.success)
				throw new ExecutorError(
					`--resume requested but ${resumePath} carries no usable conversationId`,
					2,
				);
			// Brand assertion: ConversationId is a compile-time marker over a runtime-
			// validated integer; @earendil-works/pi-durable exposes no constructor.
			const resumeId = idCheck.data as ConversationId;
			const existing = await harness.conversation(resumeId, TODO_CONTEXT as Context);
			if (!existing)
				throw new ExecutorError(
					`--resume: conversation '${idCheck.data}' not found in journal ${journalRoot}`,
					2,
				);
			conversation = existing;
		} else {
			conversation = await harness.createConversation(
				{ ownership: { kind: "ownerless" } },
				TODO_CONTEXT as Context,
			);
			await Bun.write(
				`${journalRoot}/${RESUME_FILE}`,
				`${JSON.stringify({ conversationId: conversation.id, model: spec.model })}\n`,
			);
		}
		await conversation.configure(
			{
				model: { provider: PROVIDER_ID, modelId: verdict.model.id },
				thinkingLevel: ThinkingLevelSchema.parse(args.effort),
			},
			TODO_CONTEXT as Context,
		);
		const before = usageTotalsOf(await harness.usage(TODO_CONTEXT as Context));
		await conversation.submit(
			{
				type: "input",
				content: args.prompt,
				whenBusy: "followUp",
				// Explicit requested bounds ride the request metadata — receipt-recorded,
				// never a silent ceiling (bounds are already in the spec for the receipt).
				...(spec.bounds.maxTokens !== null
					? { metadata: { blam_max_tokens: spec.bounds.maxTokens } }
					: {}),
			},
			TODO_CONTEXT as Context,
		);
		// Per-attempt usage DELTA (#123069): snapshot the cumulative durable
		// ledger before the submit; the receipt reports post − pre, never the
		// journal-wide cumulative total.
		const outcome = await waitForSettle(harness, { deadlineMs: deadline });
		const delta = usageDelta(before, usageTotalsOf(await harness.usage(TODO_CONTEXT as Context)));
		return {
			exit: outcome === "idle" ? 0 : 1,
			timedOut: outcome === "timeout",
			tokens: delta === null ? null : delta.tokens,
			cacheReadTokens: delta === null ? null : delta.cacheReadTokens,
			cacheWriteTokens: delta === null ? null : delta.cacheWriteTokens,
			conversationId: conversation.id,
		};
	} finally {
		await harness.close(TODO_CONTEXT as Context);
	}
}

