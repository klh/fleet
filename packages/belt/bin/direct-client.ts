// bin/direct-client.ts — the client-side half of the W270 direct-tier
// bypass (W280): one call that resolves a belt alias through resolveTarget()
// (reading the emitted direct-tiers.json when the policy is not pinned) and
// POSTs the OpenAI wire at the resolved base — the specialist port for a
// direct tier (engine hop skipped, +0.5-2.2 s TTFT per the W270 bench), the
// LiteLLM gateway otherwise.
//
// W278 landing review (§2 belt-router row): the bypass must skip LiteLLM,
// NOT belt policy — so the direct leg carries the router's own budget policy
// client-side (applyBudget, bin/router-core.ts) and sends the model id the
// specialist actually serves: the registry id, else "default" (the W274
// live probe: a belt alias sent raw → 10/10 404 model_not_found).
//
// Direct legs are unauthenticated loopback (parseDirect's grammar enforces
// it); gateway legs need the engine master key (LITELLM_KEY env, else the
// 0600 key file — source named in the error, never a value).
import { appendFileSync, readFileSync } from "node:fs";
import { applyBudget, type ChatMessage } from "./router-core.ts";
import {
	type DirectTiers,
	loadDirectTiers,
	resolveTarget,
} from "./router-policy.ts";

/** Operator kill switch: BELT_DIRECT_TIERS=0 sends everything through the
 *  gateway (config-over-code lever, same spirit as SUSPENDERS_SCRUB=0). */
const directEnabled = (env: Env = process.env): boolean =>
	env.BELT_DIRECT_TIERS !== "0";

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const readText: ReadFile = (path) => readFileSync(path, "utf8");

/** The model id a direct-tier specialist serves: the registry row's real id
 *  for a belt alias, else "default" (what the specialists accept for an
 *  unpinned load — the bench local-direct leg rides it). */
export const directModelId = (alias: string): string => {
	for (const s of SPECIALISTS) if (s.alias === alias) return s.model;
	return "default";
};

import { SPECIALISTS } from "./registry.ts";

/** One OpenAI-wire chat call, direct-tier resolved. */
export interface DirectChatOpts {
	/** belt alias: a direct-tier key (local-reason…) or a gateway group. */
	model: string;
	messages: ChatMessage[];
	maxTokens?: number;
	temperature?: number;
	/** Gateway base WITHOUT /v1 (resolveTarget's convention). */
	gatewayBase?: string;
	/** Pre-resolved tiers — callers with the policy in hand skip the reads. */
	direct?: DirectTiers;
	/** Kill-switch override (tests; the operator lever is the env). */
	allowDirect?: boolean;
	timeoutMs?: number;
	/** Test seams — the fleet log/key paths are machine-local. */
	fetcher?: typeof fetch;
	logPath?: string;
	read?: ReadFile;
	env?: Env;
}

export interface DirectChatResult {
	reply: string;
	ms: number;
	/** Which leg answered: the specialist port or the gateway. */
	via: "direct" | "gateway";
	/** Model id that went on the wire (registry id direct, alias gateway). */
	wireModel: string;
	/** Non-empty on an exceptional hop (e.g. direct 404 → gateway retry). */
	note?: string;
}

/** The swarm routing-log line (category "route") so belt metrics count
 *  direct legs; best-effort — a failed log write never fails the call. */
function logRoute(
	logPath: string,
	row: {
		model: string;
		port: number | null;
		duration_ms: number;
		ok: boolean;
		note: string;
	},
): void {
	try {
		appendFileSync(
			logPath,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				category: "route",
				...row,
			})}\n`,
		);
	} catch {
		// best-effort
	}
}

/** Gateway master key: LITELLM_KEY env, else the 0600 key file. Throws
 *  naming the SOURCE, never a value (litellm-target.ts loadKeys shape). */
export function loadGatewayKey(
	env: Env = process.env,
	read: ReadFile = readText,
): string {
	const fromEnv = env.LITELLM_KEY?.trim();
	if (fromEnv) return fromEnv;
	const home = env.HOME ?? "";
	const path = `${home}/.claude/local-llm/litellm.key`;
	const fromFile = tryRead(read, path)?.trim();
	if (fromFile) return fromFile;
	throw new Error(`direct-client: no gateway key (LITELLM_KEY env or ${path})`);
}

const tryRead = (read: ReadFile, path: string): string | null => {
	try {
		return read(path);
	} catch {
		return null;
	}
};

/** One chat call via the direct-tier resolver: specialist port when the
 *  alias is a direct tier (and the kill switch allows), gateway otherwise.
 *  A direct 404 model_not_found retries ONCE through the gateway (the W274
 *  adoption bug class). */
export async function directChat(o: DirectChatOpts): Promise<DirectChatResult> {
	const f = o.fetcher ?? fetch;
	const env = o.env ?? process.env;
	const gatewayBase = o.gatewayBase ?? "http://127.0.0.1:4100";
	const t0 = Date.now();
	const logPath = o.logPath ?? `${env.HOME}/.claude-insights/swarm-routing.log`;
	const tiers = directEnabled(env) ? (o.direct ?? loadDirectTiers()) : {};
	const { base, direct } = resolveTarget(o.model, gatewayBase, tiers);
	const done = (
		reply: string,
		via: "direct" | "gateway",
		wireModel: string,
		note?: string,
	): DirectChatResult => ({
		reply,
		ms: Date.now() - t0,
		via,
		wireModel,
		...(note ? { note } : {}),
	});

	const post = async (
		url: string,
		wireModel: string,
		maxTokens: number,
		headers: Record<string, string>,
		bodyExtra: Record<string, unknown> = {},
	): Promise<Response> =>
		f(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...headers,
			},
			body: JSON.stringify({
				model: wireModel,
				messages: o.messages,
				max_tokens: maxTokens,
				temperature: o.temperature,
				...bodyExtra,
			}),
			signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
		});

	const parse = async (r: Response, url: string): Promise<string> => {
		if (!r.ok) throw new Error(`HTTP ${r.status} from ${url.slice(0, 40)}`);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return j.choices?.[0]?.message?.content ?? "(empty response)";
	};

	if (direct) {
		const wireModel = directModelId(o.model);
		const { maxTokens, extra } = applyBudget(wireModel, o.maxTokens ?? 1024);
		try {
			const directUrl = `${base}/chat/completions`;
			const reply = await parse(
				await post(directUrl, wireModel, maxTokens, {}, extra),
				directUrl,
			);
			logRoute(logPath, {
				model: o.model,
				port: portOf(base),
				duration_ms: Date.now() - t0,
				ok: true,
				note: "direct",
			});
			return done(reply, "direct", wireModel);
		} catch (err) {
			if (!isNotFound(err)) throw err;
			// direct 404 → one gateway retry (W274 model_not_found class)
		}
	}

	const key = loadGatewayKey(env, o.read ?? readText);
	const gatewayUrl = `${gatewayBase}/v1/chat/completions`;
	const reply = await parse(
		await post(gatewayUrl, o.model, o.maxTokens ?? 1024, {
			authorization: `Bearer ${key}`,
		}),
		gatewayUrl,
	);
	logRoute(logPath, {
		model: o.model,
		port: null,
		duration_ms: Date.now() - t0,
		ok: true,
		note: "gateway",
	});
	return done(
		reply,
		"gateway",
		o.model,
		direct ? "direct 404 model_not_found — gateway retry" : undefined,
	);
}

const isNotFound = (err: unknown): boolean =>
	err instanceof Error && /\b404\b/.test(err.message);

const portOf = (base: string): number | null => {
	const m = /:(\d{2,5})(?:\/|$)/.exec(base);
	return m ? Number(m[1]) : null;
};
