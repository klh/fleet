// fallback-drill.ts — W219.2 gateway fallback drill, run from llm-keepwarm
// every 4 min. The 2026-10-06 z.ai TLS-interception outage exposed the gap:
// the RUNNING litellm (PID predating the config) answered /v1/models 200
// with `Fallbacks=None` while lanes hard-died instead of failing over to
// local. Liveness probes say nothing about the fallback machinery; this
// drill fires a REAL request: model glm-5.3-flash through the gateway
// (:4100). When z.ai is dark, the only rungs that answer are local ones —
// 200 + choices = the ladder works. When z.ai is up, the probe doubles as
// gateway serve/auth proof and the fallbacks stay warm.
// Secrets: the gateway master key resolves at call time — LITELLM_KEY env
// wins, else the 0600 ~/.claude/local-llm/litellm.key; used for the Bearer
// header only, never logged.
import { readFileSync } from "node:fs";

const HOME = process.env.HOME ?? "";
const GATEWAY_URL = process.env.BELT_GATEWAY_URL ?? "http://127.0.0.1:4100";
const MASTER_KEY_FILE = `${HOME}/.claude/local-llm/litellm.key`;
const ZAI_BASE = process.env.BELT_ZAI_BASE ?? "https://api.z.ai/api/anthropic";
/** The anthropic-dialect glm group every lane rides. */
const PROBE_MODEL = "glm-5.3-flash";

export interface DrillResult {
	/** z.ai unreachable — the fallback ladder is genuinely under test. */
	dark: boolean;
	/** The gateway answered the probe completion request. */
	ok: boolean;
	ms: number;
	/** Answering tier when the response exposes it (best-effort, never asserted). */
	model: string | null;
	verdict: "pass" | "fail" | "skipped";
	why: string;
}

export interface DrillDeps {
	gateway?: string;
	zaiBase?: string;
	/** Master key; null = drill skipped (no auth, the request would 401). */
	key?: string | null;
	fetchImpl?: typeof fetch;
	/** Gateway completion timeout — two dead z.ai rungs + retries first. */
	timeoutMs?: number;
	/** z.ai reachability probe timeout. */
	probeTimeoutMs?: number;
}

/** env wins, else the 0600 file. Null when both are absent. */
export function resolveMasterKey(
	env: Record<string, string | undefined> = process.env,
	read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
	const fromEnv = env.LITELLM_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		return read(MASTER_KEY_FILE).trim() || null;
	} catch {
		return null;
	}
}

/** Any HTTP reply (even 401/404) proves reachability; a throw (TLS
 *  interception, DNS, timeout) = dark. */
export async function zaiDark(
	fetchImpl: typeof fetch = fetch,
	base = ZAI_BASE,
	timeoutMs = 5_000,
): Promise<boolean> {
	try {
		const r = await fetchImpl(base, { signal: AbortSignal.timeout(timeoutMs) });
		await r.body?.cancel();
		return false;
	} catch {
		return true;
	}
}

/** One drill pass: darkness probe, then a real 1-token completion through
 *  the gateway. ok = 200 + at least one choice (max_tokens: 1 can legally
 *  yield empty content on a reasoner — the COMPLETION is the contract). */
export async function drillFallback(
	deps: DrillDeps = {},
): Promise<DrillResult> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const key = deps.key !== undefined ? deps.key : resolveMasterKey();
	if (!key)
		return {
			dark: false,
			ok: false,
			ms: 0,
			model: null,
			verdict: "skipped",
			why: `no LITELLM_KEY (env or ${MASTER_KEY_FILE})`,
		};
	const dark = await zaiDark(fetchImpl, deps.zaiBase, deps.probeTimeoutMs);
	return runRequest(fetchImpl, key, dark, deps);
}

interface Doc {
	model?: string;
	choices?: unknown[];
}

/** The probe request + verdict — split from drillFallback to keep each
 *  unit small. A throw (timeout, refused) is a failed drill. */
async function runRequest(
	fetchImpl: typeof fetch,
	key: string,
	dark: boolean,
	deps: DrillDeps,
): Promise<DrillResult> {
	const t0 = Date.now();
	let r: Response;
	try {
		r = await fetchImpl(
			`${deps.gateway ?? GATEWAY_URL}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({
					model: PROBE_MODEL,
					messages: [{ role: "user", content: `drill ${Date.now()}` }],
					max_tokens: 1,
				}),
				signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
			},
		);
	} catch (e) {
		return {
			dark,
			ok: false,
			ms: Date.now() - t0,
			model: null,
			verdict: "fail",
			why: `gateway unreachable: ${String(e).slice(0, 120)}`,
		};
	}
	const doc = (await r.json().catch(() => null)) as Doc | null;
	const ok = r.ok && (doc?.choices?.length ?? 0) > 0;
	return {
		dark,
		ok,
		ms: Date.now() - t0,
		model: doc?.model ?? null,
		verdict: ok ? "pass" : "fail",
		why: ok
			? dark
				? "z.ai dark — a local rung answered"
				: "z.ai reachable — gateway answered"
			: `gateway HTTP ${r.status}${doc ? "" : " (unparseable body)"}`,
	};
}
