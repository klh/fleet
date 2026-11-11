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
 *   advertised /v1/models listing before submitting (W2677) and records the
 *   verdict in the spec's `routeCompat`. No model-name gating.
 * - No silent ceilings: the run is unbounded unless the caller passes an
 *   explicit wall-clock deadline; the durable conversation carries no token
 *   or turn caps of its own.
 * - Usage is read from the durable ledger (`harness.usage`), never from
 *   provider advertising alone; unreported legs stay null.
 */

import { createModels, createProvider, type Models } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { TODO_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import {
	type DurableRunSpec,
	type ExecutorArgs,
	type AttemptResult,
	ExecutorError,
} from "./pi-durable-strategy.ts";

const PROVIDER_ID = "blam-route";
/** Catalog attribute of the model entry, not a request-level cap. */
const CATALOG_MAX_TOKENS = 32768;

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Response | Promise<Response>;

/** Look the model up in the route's advertised /v1/models listing. */
export async function verifyRouteAdvertised(options: {
	baseUrl: string;
	token: string;
	model: string;
	fetchImpl?: FetchLike;
}): Promise<boolean> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const url = `${options.baseUrl.replace(/\/$/, "")}/v1/models`;
	const response = await fetchImpl(url, {
		headers: { authorization: `Bearer ${options.token}` },
	});
	if (!response.ok) return false;
	const body = (await response.json()) as {
		data?: readonly { id?: string }[];
	};
	return (body.data ?? []).some((entry) => entry.id === options.model);
}

/** One-provider Models whose only model rides the openai-completions wire. */
export function buildModels(options: {
	baseUrl: string;
	token: string;
	model: string;
}): Models {
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
				id: options.model,
				name: options.model,
				api: "openai-completions",
				provider: PROVIDER_ID,
				baseUrl: options.baseUrl,
				input: ["text"],
				reasoning: true,
				contextWindow: 200000,
				maxTokens: CATALOG_MAX_TOKENS,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		api: { "openai-completions": { stream, streamSimple } },
	});
	models.setProvider(provider);
	return models;
}

type WaitOutcome = "idle" | "failed" | "timeout";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

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

/**
 * Run one live attempt end-to-end: verify the route, open the durable
 * journal + harness under `env.BLAM_PI_DURABLE_ROOT`, submit the prompt,
 * wait for settle, and read usage from the durable ledger.
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
	const { openNodeJsonlStorage } = await import(
		"@earendil-works/pi-durable/storage/jsonl/node"
	);
	const advertised = await verifyRouteAdvertised({
		baseUrl: env.baseUrl,
		token: env.token,
		model: spec.model,
		fetchImpl,
	});
	const verifiedSpec: DurableRunSpec = { ...spec, routeCompat: advertised ? "advertised" : "unverified" };
	const storage = await openNodeJsonlStorage(
		env.BLAM_PI_DURABLE_ROOT,
		TODO_CONTEXT as Context,
	);
	const deadline =
		env.BLAM_PI_DURABLE_DEADLINE_MS !== undefined
			? Number.parseInt(env.BLAM_PI_DURABLE_DEADLINE_MS, 10)
			: undefined;
	const harness = await Harness.open(
		storage,
		{
			models: buildModels({ baseUrl: env.baseUrl, token: env.token, model: verifiedSpec.model }),
			registry: createRegistry(),
		},
		TODO_CONTEXT as Context,
	);
	try {
		const conversation = await harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			TODO_CONTEXT as Context,
		);
		await conversation.configure(
			{ model: { provider: PROVIDER_ID, modelId: verifiedSpec.model } },
			TODO_CONTEXT as Context,
		);
		await conversation.submit(
			{ type: "input", content: args.prompt, whenBusy: "followUp" },
			TODO_CONTEXT as Context,
		);
		const outcome = await waitForSettle(harness, { deadlineMs: deadline });
		const usage = await harness.usage(TODO_CONTEXT as Context);
		let tokens = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let reported = false;
		for (const bucket of Object.values(usage.models)) {
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
		return {
			exit: outcome === "idle" ? 0 : 1,
			timedOut: outcome === "timeout",
			tokens: reported ? tokens : null,
			cacheReadTokens: reported ? cacheRead : null,
			cacheWriteTokens: reported ? cacheWrite : null,
		};
	} finally {
		await harness.close(TODO_CONTEXT as Context);
	}
}
