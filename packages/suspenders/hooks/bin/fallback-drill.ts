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
import { YAML } from "bun";
import {
	cacheUsageReported,
	type Usage,
	usageFromAnthropic,
} from "../../../buckle/src/usage.ts";

const HOME = process.env.HOME ?? "";
const GATEWAY_URL = process.env.BELT_GATEWAY_URL ?? "http://127.0.0.1:4100";
const MASTER_KEY_FILE = `${HOME}/.claude/local-llm/litellm.key`;
/** The LIVE gateway config (:4100 loads it at boot) — the W878 ladder
 *  assertion reads it; env override for tests/alt deployments. */
const GATEWAY_CONFIG =
	process.env.BELT_GATEWAY_CONFIG ?? `${HOME}/.claude/local-llm/litellm.yaml`;
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
	/** W878: ladders asserted present in the LIVE gateway config — false
	 *  fails the drill even when z.ai answers (the F2 vacuous-pass gap). */
	laddersPresent: boolean;
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
	/** Live gateway config path (default GATEWAY_CONFIG). */
	configPath?: string;
	/** Config reader override for tests; a throw = unreadable. */
	readConfig?: (path: string) => string;
}

/** Parse verdict of the litellm_settings.fallbacks ladder assertion. */
export interface LadderCheck {
	present: boolean;
	/** Model groups carrying a ladder (empty when absent/unparseable). */
	groups: string[];
	why: string;
}

/** W878 (F2, W499): the drill must fail closed when the LIVE gateway config
 *  carries no litellm_settings.fallbacks — with z.ai healthy a completion
 *  pass is trivially true with or without ladders (F1 sat 12 days this
 *  way). Pure parse of the emitted shape: a list of single-key maps. */
export function checkFallbacksPresent(text: string): LadderCheck {
	let doc: { litellm_settings?: { fallbacks?: unknown } } | null;
	try {
		doc = YAML.parse(text) as typeof doc;
	} catch {
		return { present: false, groups: [], why: "gateway config unparseable" };
	}
	const fb = doc?.litellm_settings?.fallbacks;
	if (!Array.isArray(fb) || fb.length === 0)
		return {
			present: false,
			groups: [],
			why: "no litellm_settings.fallbacks in the gateway config",
		};
	const groups = fb.flatMap((row) =>
		row && typeof row === "object" && !Array.isArray(row)
			? Object.keys(row)
			: [],
	);
	if (groups.length === 0)
		return {
			present: false,
			groups: [],
			why: "litellm_settings.fallbacks has no usable rows",
		};
	return { present: true, groups, why: `ladders: ${groups.join(", ")}` };
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

/** One drill pass: key → ladder assertion (W878: the config must carry
 *  litellm_settings.fallbacks, else fail even when z.ai answers) → darkness
 *  probe, then a real 1-token completion through the gateway. ok = 200 + at
 *  least one choice (max_tokens: 1 can legally yield empty content on a
 *  reasoner — the COMPLETION is the contract). */
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
			laddersPresent: false,
			verdict: "skipped",
			why: `no LITELLM_KEY (env or ${MASTER_KEY_FILE})`,
		};
	const read = deps.readConfig ?? ((p: string) => readFileSync(p, "utf8"));
	const configPath = deps.configPath ?? GATEWAY_CONFIG;
	let ladders: LadderCheck;
	try {
		ladders = checkFallbacksPresent(read(configPath));
	} catch (e) {
		ladders = {
			present: false,
			groups: [],
			why: `gateway config unreadable: ${String(e).slice(0, 120)}`,
		};
	}
	const dark = await zaiDark(fetchImpl, deps.zaiBase, deps.probeTimeoutMs);
	return runRequest(fetchImpl, key, dark, deps, ladders);
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
	ladders: LadderCheck,
): Promise<DrillResult> {
	const t0 = Date.now();
	let r: Response;
	try {
		r = await fetchImpl(`${deps.gateway ?? GATEWAY_URL}/v1/chat/completions`, {
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
		});
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
	const served = ok && ladders.present;
	return {
		dark,
		ok,
		ms: Date.now() - t0,
		model: doc?.model ?? null,
		laddersPresent: ladders.present,
		verdict: served ? "pass" : "fail",
		why: !ok
			? `gateway HTTP ${r.status}${doc ? "" : " (unparseable body)"}`
			: ladders.present
				? dark
					? "z.ai dark — a local rung answered"
					: "z.ai reachable — gateway answered"
				: `gateway answered but ${ladders.why}`,
	};
}

// ---- W901.1 cache-share drill — finding 2 of the cache-aware audit
// (docs/cache-aware-clone-reuse-audit.md): the fallback drill above proves
// gateway-up, not cache-warm. A silent cache-share regression (affinity off,
// prefix drift, a non-reporting rung on top) would surface only in the
// lane-cache jsonl — nothing alerts. One attributed same-prefix pair per
// workhorse route: the keepwarm's captured lane prefix (tools+system,
// byte-stable) + a per-route model, fired twice with fresh nonces through
// the buckle front /w/<CACHE_SID> (the lane path — affinity, gate alignment
// and upstream cache in one probe; route_audit attributes the traffic).
// Asserts on the SECOND call: cache fields reported at all, hit share ≥
// floor; below floor = fail (the ✗ line is the alert).

/** The drill's lane identity on the front (/w/<slug> → route_audit.lane). */
export const CACHE_SID = "cache-drill";

/** The captured lane prefix, structural — prefix-keepwarm's CapturedPrefix
 *  satisfies it. No import: that module runs its CLI on import. */
export interface DrillPrefix {
	model: string;
	tools: unknown[];
	system: unknown;
}

/** Per-route verdict of the cache-share drill. */
export interface CacheRouteResult {
	route: string;
	verdict: "pass" | "fail" | "skipped";
	/** Warm-call hit share = cache_r / (in + read + create); null = no usage. */
	share: number | null;
	ms: number;
	why: string;
}

/** Aggregate: any route fail → fail; all skipped → skipped; else pass. */
export interface CacheDrillResult {
	verdict: "pass" | "fail" | "skipped";
	routes: CacheRouteResult[];
	floor: number;
	why: string;
}

/** The audit-verified workhorse routes (audit §2 — the three live-verified
 *  cache-reporting routes; nas ollama is marked non-reporting, gpt-5.2
 *  dormant). Env: BELT_CACHE_DRILL_ROUTES (comma-separated). */
export const DEFAULT_CACHE_ROUTES: string[] = [
	"glm-5.3-flash",
	"zai-glm-5.3-flash",
	"local-swarm",
];

/** Warm-call hit-share floor. The audit micro-probe reads ~0.98 warm; 0.5
 *  = the warm call must read at least half its input from cache. Env:
 *  BELT_CACHE_DRILL_FLOOR. */
export const DEFAULT_CACHE_FLOOR = 0.5;

/** Route set: env wins, junk/empty falls back to the audit-verified set. */
export function drillRoutes(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const raw = env.BELT_CACHE_DRILL_ROUTES?.trim();
	if (!raw) return DEFAULT_CACHE_ROUTES;
	const routes = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return routes.length > 0 ? routes : DEFAULT_CACHE_ROUTES;
}

/** Floor: env wins; junk/out-of-range falls back to 0.5. */
export function drillFloor(
	env: Record<string, string | undefined> = process.env,
): number {
	const n = Number(env.BELT_CACHE_DRILL_FLOOR);
	return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_CACHE_FLOOR;
}

/** Warm-call hit share — the LaneTelemetryLog.summarize split: reads over
 *  all input (uncached + reads + writes). null = no input totals at all. */
export function cacheHitShare(u: Usage | null): number | null {
	if (!u) return null;
	const input = u.in_tok + u.cache_r + u.cache_c;
	return input > 0 ? u.cache_r / input : null;
}

/** One same-prefix pair per route. cold: usage tells (a creation is legal —
 *  the prefix must be written once); warm: cache fields must be REPORTED
 *  and the share must clear the floor. All calls ride /w/<CACHE_SID> so the
 *  traffic is attributed, and carry cache-control: ephemeral on the prefix
 *  system block so anthropic rows place the breakpoint (W768 alignment). */
export async function drillCacheShare(o: {
	front: string;
	key: string;
	routes: string[];
	prefix: DrillPrefix | null;
	floor: number;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<CacheDrillResult> {
	if (!o.prefix)
		return {
			verdict: "skipped",
			routes: [],
			floor: o.floor,
			why: "no captured lane prefix — run: bun hooks/bin/prefix-keepwarm.ts --capture",
		};
	if (o.routes.length === 0)
		return { verdict: "skipped", routes: [], floor: o.floor, why: "no routes" };
	const fetchImpl = o.fetchImpl ?? fetch;
	const results: CacheRouteResult[] = [];
	for (const route of o.routes)
		results.push(await drillCacheRoute(route, o, fetchImpl));
	const failed = results.filter((r) => r.verdict === "fail");
	const verdict: "pass" | "fail" | "skipped" =
		failed.length > 0
			? "fail"
			: results.every((r) => r.verdict === "skipped")
				? "skipped"
				: "pass";
	const why =
		verdict === "pass"
			? results.map((r) => `${r.route} ${fmtShare(r.share)}`).join(", ")
			: (failed[0]?.why ?? "skipped");
	return { verdict, routes: results, floor: o.floor, why };
}

const fmtShare = (s: number | null): string =>
	s === null ? "no-usage" : `${(s * 100).toFixed(1)}%`;

/** The warm body: prefix verbatim (system carries a cache-control
 *  breakpoint; openai-compat rows ignore it, prefix-implicit) + one nonce
 *  user message. max_tokens: 1. */
function drillBody(
	prefix: DrillPrefix,
	nonce: number,
): Record<string, unknown> {
	const system = Array.isArray(prefix.system)
		? [
				...prefix.system,
				{
					type: "text",
					text: "cache-drill breakpoint",
					cache_control: { type: "ephemeral" },
				},
			]
		: prefix.system;
	return {
		model: prefix.model,
		max_tokens: 1,
		tools: prefix.tools,
		system,
		messages: [{ role: "user", content: `cache-drill ${nonce}` }],
	};
}

/** The per-route pair: cold pass then warm pass on the SAME prefix. */
async function drillCacheRoute(
	route: string,
	o: {
		front: string;
		key: string;
		prefix: DrillPrefix;
		floor: number;
		timeoutMs?: number;
	},
	fetchImpl: typeof fetch,
): Promise<CacheRouteResult> {
	const url = `${o.front}/w/${CACHE_SID}/v1/messages`;
	const call = async (nonce: number) =>
		fetchImpl(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				authorization: `Bearer ${o.key}`,
			},
			body: JSON.stringify(drillBody(o.prefix, nonce)),
			signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
		});
	return runCachePair(route, o, call);
}

/** The pair verdict: cold must answer (a creation is legal), warm must
 *  REPORT cache fields and clear the floor. */
async function runCachePair(
	route: string,
	o: { prefix: DrillPrefix; floor: number; timeoutMs?: number },
	call: (nonce: number) => Promise<Response>,
): Promise<CacheRouteResult> {
	const t0 = Date.now();
	try {
		const cold = await call(Date.now());
		await cold.body?.cancel();
		if (!cold.ok)
			return {
				route,
				verdict: "fail",
				share: null,
				ms: Date.now() - t0,
				why: `cold pass HTTP ${cold.status}`,
			};
		return await warmHalf(route, o, call, t0);
	} catch (e) {
		return {
			route,
			verdict: "fail",
			share: null,
			ms: Date.now() - t0,
			why: `front unreachable: ${String(e).slice(0, 120)}`,
		};
	}
}

/** Warm pass + verdict: cache fields reported, share ≥ floor. */
async function warmHalf(
	route: string,
	o: { prefix: DrillPrefix; floor: number },
	call: (nonce: number) => Promise<Response>,
	t0: number,
): Promise<CacheRouteResult> {
	const warm = await call(Date.now());
	const doc = (await warm.json().catch(() => null)) as {
		usage?: unknown;
	} | null;
	const ms = Date.now() - t0;
	if (!warm.ok)
		return {
			route,
			verdict: "fail",
			share: null,
			ms,
			why: `warm pass HTTP ${warm.status}`,
		};
	return cacheVerdict(route, o.floor, doc?.usage, ms);
}

/** The warm verdict: reported fields + floor, else the alert-shaped fail. */
function cacheVerdict(
	route: string,
	floor: number,
	usage: unknown,
	ms: number,
): CacheRouteResult {
	if (!cacheUsageReported("anthropic", usage))
		return {
			route,
			verdict: "fail",
			share: null,
			ms,
			why: "route answered but reported NO cache usage fields (non-caching or non-reporting rung on top)",
		};
	const share = cacheHitShare(usageFromAnthropic(usage));
	return share !== null && share >= floor
		? {
				route,
				verdict: "pass",
				share,
				ms,
				why: `warm cache share ${fmtShare(share)} ≥ floor ${floor}`,
			}
		: {
				route,
				verdict: "fail",
				share,
				ms,
				why: `warm cache share ${fmtShare(share)} below floor ${floor} (affinity off, prefix drift, or a non-caching rung on top)`,
			};
}
