#!/usr/bin/env bun
// router-shim.ts — LLM specialist swarm router v3.
// Anthropic API format on :4000 → complexity-scored routing across the local
// mlx swarm, bounded fallback to an alternate specialist, then optional cloud
// escalation (prefs-gated). Policy + upstream I/O live in router-core.ts
// (importable for tests); stream:true is piped through as Anthropic SSE.
//
// Routing preference + cloud switch live in prefs.json (same dir):
//   { "cost_speed": "balanced"|"cost"|"speed"|"quality", "allow_cloud": bool }
// Cloud escalation fires only when: allow_cloud=true, cost mode isn't active,
// local failed twice, and the task is COMPLEX/VERY_COMPLEX (SIMPLE never
// leaves the machine).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	createAdmission,
	overloaded,
	parsePortCaps,
	releaseAfterCleanup,
} from "./admission.ts";
import { audioSpeech, audioTranscribe } from "./audio.ts";
import { livenessResponse } from "./health.ts";
import { promptFingerprint } from "./prompt-fingerprint.ts";
import {
	byPort,
	fallbackFor,
	needsDemandStart,
	ROUTER,
	SPECIALISTS,
	type Specialist,
} from "./registry.ts";
import { registryResponse } from "./registry-emit.ts";
import { routerRuntimeRevision } from "./router-runtime-revision.ts";
import {
	applyInboundCondense,
	type CondenseMeta,
	type CondensePrefs,
} from "./router-condense.ts";
import {
	type AnthropicBody,
	anthropicSseFromOpenAi,
	type OpenAiToolCall,
	anthropicSseFromText,
	applyBudget,
	callHonoringRetryAfter,
	classifierText,
	classifyELabel,
	kevEligible,
	kevEscalateVeto,
	openLocalStream,
	type RequestTimings,
	scoreComplexity,
	stopReason,
	toOpenAiMessages,
	toolChoiceToOpenAi,
	toOpenAiTools,
	viaLocal,
} from "./router-core.ts";
import { parseToolArgs } from "./router-tools.ts";
// W1303.3: per-specialist breakers ride the shared resilience kit.
import { Breakers } from "../../buckle/src/resilience.ts";
// W422.17.3 governor note: re-read after the /tmp splice that moved viaCloud
// out; this adds the import for the extracted escalation leg.
import { escalate } from "./escalate.ts";
import { ensureAvailable } from "./spawner.ts";
import {
	beginTrace,
	childTraceparent,
	stampResponse,
} from "../../telemetry/src/http-trace.ts";
import {
	parsePreferHeader,
	PREFER_HEADER,
} from "../../telemetry/src/prefer-header.ts";

// W504: per-provider request caps — registry rows carry maxInflight for the
// big unified-memory backends (:8901/:8903); BELT_PORT_CAPS ("8903:1,8901:3")
// overrides per port (operator knob wins over code default). A full port →
// 429 + Retry-After: fall-through per the ladder, the router never queues.
const REGISTRY_CAPS: Record<number, number> = {};
for (const s of SPECIALISTS)
	if (typeof s.maxInflight === "number") REGISTRY_CAPS[s.port] = s.maxInflight;
const admission = createAdmission(undefined, undefined, {
	...REGISTRY_CAPS,
	...parsePortCaps(process.env.BELT_PORT_CAPS),
});

const HOME = process.env.HOME;
const PREFS_FILE = `${HOME}/.claude/local-llm/prefs.json`;
const ROUTING_LOG = `${HOME}/.claude-insights/swarm-routing.log`;
// Captured before serving requests. Re-reading the file on every health probe
// would falsely claim an old process had loaded newly installed modules.
const loadedRevision = routerRuntimeRevision(import.meta.path);
let routingLogReady = false;

function logRouting(entry: Record<string, unknown>) {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	try {
		if (!routingLogReady) {
			mkdirSync(dirname(ROUTING_LOG), { recursive: true });
			routingLogReady = true;
		}
		appendFileSync(ROUTING_LOG, `${line}\n`);
	} catch (error) {
		console.error(
			`router: route receipt write failed (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
		);
	}
}

type Prefs = {
	cost_speed?: "balanced" | "cost" | "speed" | "quality";
	allow_cloud?: boolean;
	profile?: string[];
	routing_table?: Record<string, number>;
	kev?: { enabled?: boolean; port?: number; ambiguity_band?: [number, number] };
	condense?: CondensePrefs;
};
async function loadPrefs(): Promise<Prefs> {
	try {
		return JSON.parse(await Bun.file(PREFS_FILE).text());
	} catch {
		return {};
	}
}

// cloud gate: operator cost law — only prefs can authorize the cloud leg
const cloudAllowed = (p: Prefs): boolean =>
	p.allow_cloud === true && p.cost_speed !== "cost";

function upstreamDecline(
	status: number,
	retryAfterMs: number | undefined,
	details: string[],
): Response {
	const retrySeconds = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1000));
	const rateLimited = status === 429;
	return Response.json(
		{
			type: "error",
			error: {
				type: rateLimited ? "overloaded_error" : "api_error",
				message: `router: upstream HTTP ${status} (${details.join("; ")})${rateLimited ? `; retry after ${retrySeconds}s` : ""}`,
			},
		},
		{
			status: rateLimited ? 429 : 502,
			headers: rateLimited ? { "retry-after": String(retrySeconds) } : {},
		},
	);
}

// arithmetic lane: a pure-math ask is evaluated directly, never sent to an
// LLM — Qwen3-4B deterministically answers 17*23 -> "401" at temp 0 (verified
// 2026-09-23). Strict allowlist; anything ambiguous fails safe to the LLM.
const ARITH_LEAD =
	/^(what\s+is|what's|whats|calculate|compute|how\s+much\s+is|how\s+many\s+is|hvad\s+er|hvor\s+meget\s+er)\s+/i;
const ARITH_TAIL =
	/\s*[,.;]?\s*(answer|reply|respond|svar)(\s+\w+){0,3}\s*(the\s+)?(number|result|tallet)(\s+only)?[.]*$/i;
function arithmeticAnswer(text: string): string | null {
	let t = text
		.trim()
		.replace(ARITH_LEAD, "")
		.replace(ARITH_TAIL, "")
		.replace(/[?!.]+$/, "")
		.trim();
	if (!t || t.length > 120) return null;
	t = t.replace(/\bx\b|×/gi, "*").replace(/÷/g, "/");
	if (!/^[\d\s+\-*/()]+$/.test(t)) return null; // strict charset
	if (!/\d/.test(t) || (!/[+*/]/.test(t) && !/\d\s*-\s*\d/.test(t)))
		return null; // need an operator
	const tokens = t.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
	if (!tokens) return null;
	const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
	const out: (number | string)[] = [];
	const ops: string[] = [];
	let prev: "n" | "op" | "(" | ")" | null = null;
	for (const tk of tokens) {
		if (/^\d/.test(tk)) {
			out.push(parseFloat(tk));
			prev = "n";
			continue;
		}
		if (tk === "(") {
			ops.push(tk);
			prev = "(";
			continue;
		}
		if (tk === ")") {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(") break;
				ops.pop();
				out.push(top);
			}
			if (!ops.includes("(")) return null;
			ops.pop();
			prev = ")";
			continue;
		}
		if (tk === "-" && (prev === null || prev === "op" || prev === "("))
			out.push(0); // unary minus
		else {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(" || (prec[top] ?? 0) < prec[tk])
					break;
				ops.pop();
				out.push(top);
			}
		}
		ops.push(tk);
		prev = "op";
	}
	while (ops.length) {
		const o = ops.pop();
		if (o === undefined || o === "(") return null;
		out.push(o);
	}
	const st: number[] = [];
	for (const tk of out) {
		if (typeof tk === "number") {
			st.push(tk);
			continue;
		}
		const b = st.pop();
		const a = st.pop();
		if (a === undefined || b === undefined) return null;
		st.push(
			tk === "+" ? a + b : tk === "-" ? a - b : tk === "*" ? a * b : a / b,
		);
	}
	if (st.length !== 1 || !Number.isFinite(st[0])) return null;
	const r = st[0];
	return String(
		Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : Number(r.toFixed(6)),
	);
}

// ─── routes derived from registry.ts (single source of truth) ───
// fail fast at boot on a misconfigured registry, not mid-request
const specialist = (port: number): Specialist => {
	const s = byPort(port);
	if (!s) throw new Error(`registry: no specialist on :${port}`);
	return s;
};
const CODE = specialist(8901);
const REASON = specialist(8903);
const EXTRACT = specialist(8902);
const DANISH = specialist(8906); // tier:"ondemand" — spawned on first request
const TIER_ROUTES: Record<string, Specialist> = {
	SIMPLE: EXTRACT,
	MEDIUM: CODE,
	COMPLEX: REASON,
	VERY_COMPLEX: REASON,
};

// ─── cloud escalation ───
// W422.17.3: the escalation leg lives in escalate.ts — gate mode
// (BELT_ESCALATE_URL/KEY, operator-minted buckle:proxy:WRITE_ key,
// route_audit row) with the legacy settings.json litellm leg as fallback.
// The one call site passes body + budget + tier; creds live in machine
// config, never code.

// selftest: fire one request whose primary target is a dead port, asserting
// the fallback branch answers. The path otherwise almost never runs — first
// real firing ever (Sep 23) crashed on a stale FALLBACKS table.
if (process.argv[2] === "selftest") {
	const base = `http://127.0.0.1:${process.env.BELT_ROUTER_PORT ?? 4000}`;
	const t0 = performance.now();
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 60,
			_force_dead_port: 59999,
			messages: [{ role: "user", content: "Reply with the word OK." }],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		_routing?: { note?: string };
		content?: Array<{ text?: string }>;
	};
	const note = String(d._routing?.note ?? "");
	const text = String(d.content?.[0]?.text ?? "");
	if (!note.includes("forced dead primary")) {
		console.log(
			`✗ selftest hook disarmed — restart the shim with BELT_SELFTEST=1 and rerun (note="${note}")`,
		);
		process.exit(2);
	}
	const ok = r.status === 200 && note.includes("fallback") && text.length > 0;
	console.log(
		`${ok ? "✓" : "✗"} fallback ${ok ? "verified" : "BROKEN"} — status=${r.status} note="${note}" head="${text.slice(0, 40)}" (${Math.round(performance.now() - t0)}ms)`,
	);
	process.exit(ok ? 0 : 1);
}

// selftest-danish: fire one request that must land on the on-demand
// generalist :8906 — asserts detection + spawn-on-demand. Needs :8906 either
// warm or spawnable; run against BELT_ROUTER_PORT for side-by-side checks.
if (process.argv[2] === "selftest-danish") {
	const base = `http://127.0.0.1:${process.env.BELT_ROUTER_PORT ?? 4000}`;
	const t0 = performance.now();
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 60,
			messages: [
				{
					role: "user",
					content:
						"Hvad er forskellen på hypotese og teori? Forklar venligst kort.",
				},
			],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		_routing?: { port?: number; note?: string };
		content?: Array<{ text?: string }>;
	};
	const note = String(d._routing?.note ?? "");
	const text = String(d.content?.[0]?.text ?? "");
	const ok = r.status === 200 && d._routing?.port === 8906 && text.length > 0;
	console.log(
		`${ok ? "✓" : "✗"} danish ondemand ${ok ? "verified" : "BROKEN"} — status=${r.status} port=${d._routing?.port} note="${note}" head="${text.slice(0, 40)}" (${Math.round(performance.now() - t0)}ms)`,
	);
	process.exit(ok ? 0 : 1);
}

// ─── Anthropic↔OpenAI shim ───
// BELT_ROUTER_PORT: side-by-side runs (tests, canary) without disturbing :4000.
const ROUTER_PORT = Number(process.env.BELT_ROUTER_PORT ?? 4000);

type Attempt = {
	cleanup?: Promise<void>;
	ok: boolean;
	error?: string;
	status?: number;
	retryAfterMs?: number;
};

// W1303.3: per-specialist circuit breakers from the resilience kit —
// ordered failover skips an open breaker instead of knocking on a dead
// specialist; closed → open after 5 consecutive failures, half-open single
// probe after 30s. Outcome recording rides the ladder's result.
const breakers = new Breakers({ failureThreshold: 5, openMs: 30_000 });
const breakerId = (port: number): string => `belt:${port}`;

/** Primary → one bounded fallback (admission-gated). The fallback slot is
 *  returned, not released: a stream holds it until the last byte. */
async function ladder<R extends Attempt>(
	route: Specialist,
	primary: Specialist,
	call: (t: Specialist) => Promise<R>,
	note: string[],
	errors: string[],
): Promise<{
	result: R;
	used: Specialist;
	fbRelease?: () => void;
	retryAfterMs?: number;
	coldDeferred?: boolean;
}> {
	const primaryReady =
		!process.env.BELT_UPSTREAM_BASE && needsDemandStart(primary)
			? await ensureAvailable(primary)
			: undefined;
	const pId = breakerId(primary.port);
	let result =
		primaryReady && !primaryReady.up
			? ({ ok: false, status: 503, error: primaryReady.error } as R)
			: await callHonoringRetryAfter(() => call(primary));
	let used = primary;
	let coldDeferred = primaryReady !== undefined && !primaryReady.up;
	let retryAfter =
		result.status === 429 ? (result.retryAfterMs ?? 0) : undefined;
	if (primaryReady && !primaryReady.up) retryAfter = primaryReady.retryAfterMs;
	if (result.ok) {
		breakers.success(pId);
		return { result, used };
	}
	breakers.failure(pId);
	errors.push(`:${primary.port} ${result.error ?? "empty"}`);
	const fb = fallbackFor(route.port);
	if (!fb) return { result, used, retryAfterMs: retryAfter, coldDeferred };
	const fId = breakerId(fb.port);
	// W1303.3: ordered failover skips an OPEN breaker — the fallback attempt
	// would knock on a specialist the breaker just benched.
	if (!breakers.canAttempt(fId)) {
		note.push(`fallback :${fb.port} breaker open — skipped`);
		return { result, used, retryAfterMs: retryAfter, coldDeferred };
	}
	const fbRelease = admission.tryAcquire(fb.port);
	if (!fbRelease) {
		note.push(`fallback :${fb.port} at max in-flight`);
		return { result, used, retryAfterMs: retryAfter, coldDeferred };
	}
	note.push(`fallback → :${fb.port}`);
	if (!process.env.BELT_UPSTREAM_BASE && needsDemandStart(fb)) {
		const ready = await ensureAvailable(fb);
		if (!ready.up) {
			fbRelease();
			errors.push(
				`:${fb.port} demand start deferred: ${ready.error ?? "not ready"}`,
			);
			coldDeferred = true;
			return {
				result,
				used,
				retryAfterMs: Math.max(retryAfter ?? 0, ready.retryAfterMs),
				coldDeferred,
			};
		}
	}
	result = await callHonoringRetryAfter(() => call(fb));
	used = fb;
	if (result.status === 429)
		retryAfter = Math.max(retryAfter ?? 0, result.retryAfterMs ?? 0);
	if (result.ok) {
		breakers.success(fId);
		return { result, used, fbRelease };
	}
	breakers.failure(fId);
	releaseAfterCleanup(fbRelease, result.cleanup ? [result.cleanup] : []);
	errors.push(`:${fb.port} ${result.error ?? "empty"}`);
	return { result, used, retryAfterMs: retryAfter, coldDeferred };
}

// header = ASCII essentials only (the note carries "→"); full _routing rides
// in message_start
const sseHeaders = (routing: Record<string, unknown>) => ({
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	"x-belt-routing": JSON.stringify({
		tier: routing.tier,
		category: routing.category,
		port: routing.port,
		model: routing.model,
	}).replace(/[^\x20-\x7e]/g, "?"),
	...condenseResponseHeaders(routing),
});

// W304.2: per-request condense metadata — X-Condense-Version + rules-fired
// count once the knob is on. Also the input any FUTURE response-cache key
// must include (belt keeps no response cache today; see router-condense.ts).
const condenseResponseHeaders = (
	routing: Record<string, unknown>,
): Record<string, string> => {
	const c = routing.condense as { version: string; rules: number } | undefined;
	if (!c) return {};
	return {
		"x-condense-version": String(c.version),
		"x-condense-rules": String(c.rules),
	};
};

Bun.serve({
	port: ROUTER_PORT,
	// W204: loopback-only — never a raw LAN bind; external access only via an
	// authenticated Caddy hop. (The runtime copy carried this fix; the repo
	// copy had drifted without it — W465 closes the drift.)
	hostname: "127.0.0.1",
	idleTimeout: 0, // streams may idle through a long prefill
	async fetch(req) {
		const url = new URL(req.url);
		// W1081: every envelope identifies its emitter — the ingress trace
		// begins once at fetch top so the early paths (404, audio, registry)
		// stamp the same x-klh set as the /v1/messages ladder below.
		const trace = beginTrace(req.headers);
		const preference = parsePreferHeader(req.headers.get(PREFER_HEADER));
		const stamped = (
			response: Response,
			hop: string,
			extra: {
				refusal?: string;
				attempts?: number;
				upstreamStatus?: number;
				upstreamKind?: string;
				upstreamId?: string;
				callId?: string;
			} = {},
		): Response => {
			const stamped = stampResponse(response, {
				service: "belt",
				hop,
				traceId: trace.traceId,
				requestId: trace.requestId,
				...extra,
			});
			stamped.headers.delete(PREFER_HEADER);
			if (preference) stamped.headers.set(PREFER_HEADER, preference);
			return stamped;
		};

		const health = livenessResponse(req, "belt-router", {
			router: "complexity-v3",
		});
		// livenessResponse stamps itself (service = "belt-router") — no re-wrap
		if (health) {
			if (loadedRevision)
				health.headers.set("x-belt-runtime-revision", loadedRevision);
			return health;
		}

		// W271: the full registry (ETag'd); hubs proxy it, spokes pull it
		if (
			(req.method === "GET" || req.method === "HEAD") &&
			url.pathname === "/registry.json"
		)
			return stamped(registryResponse(req), "ingress");

		// ─── W440 audio tier: TTS/STT behind the router (OpenAI wire) ───
		// Handlers live in bin/audio.ts (rows: registry.ts AUDIO_SERVICES);
		// the vendor key is machine config — a missing key is a clean 503.
		if (req.method === "POST" && url.pathname === "/v1/audio/speech")
			return stamped(await audioSpeech(req), "ingress");

		if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions")
			return stamped(await audioTranscribe(req), "ingress");

		if (req.method !== "POST" || url.pathname !== "/v1/messages") {
			return stamped(
				Response.json({ error: "not found" }, { status: 404 }),
				"ingress",
				{ refusal: "no_route" },
			);
		}

		let body: AnthropicBody;
		try {
			body = await req.json();
		} catch {
			logRouting({
				event: "request_completed",
				trace_id: trace.traceId,
				request_id: trace.requestId,
				http_status: 400,
				outcome: "bad_json",
				attempts: 0,
			});
			return stamped(
				Response.json({ error: "bad json" }, { status: 400 }),
				"ingress",
				{ refusal: "bad_json" },
			);
		}

		const startTime = Date.now();
		const t0 = performance.now();
		const text = classifierText(body);
		const wantStream = body.stream === true;

		// score complexity and select specialist:
		//   code-ish → coder; everything non-SIMPLE prose → 27B general; else 4B
		const prefs = await loadPrefs();
		// A request sent by LiteLLM to this local router must never escalate
		// back into LiteLLM's fallback ladder. The group alias is registry data.
		const cloudAllowedForRequest =
			body.model !== ROUTER.gatewayAlias && cloudAllowed(prefs);
		const score = scoreComplexity(text);

		// arithmetic lane — zero tokens, zero model calls
		const arith = arithmeticAnswer(text);
		if (arith !== null) {
			logRouting({
				event: "request_completed",
				trace_id: trace.traceId,
				request_id: trace.requestId,
				http_status: 200,
				outcome: "in_process",
				attempts: 0,
				duration_ms: Math.round(performance.now() - t0),
			});
			const id = `msg_arith_${Date.now()}`;
			const routing = { tier: "SIMPLE", category: "arithmetic" };
			// no upstream leg — the lane answers in-process
			const timings = { total_ms: Math.round(performance.now() - t0) };
			if (wantStream)
				return stamped(
					new Response(
						anthropicSseFromText(arith, {
							id,
							model: body.model,
							routing,
							timings,
						}),
						{ headers: sseHeaders(routing) },
					),
					"in_process",
				);
			return stamped(
				Response.json({
					id,
					type: "message",
					role: "assistant",
					model: body.model,
					content: [{ type: "text", text: arith }],
					stop_reason: "end_turn",
					usage: { input_tokens: 0, output_tokens: 0 },
					_routing: routing,
					_server_timings: timings,
				}),
				"in_process",
			);
		}

		const isCode = score.dimensions.codePresence > 0.5;
		// W279: serving-tier decision (e-label) — the label rides _routing.category
		const el = classifyELabel(text, score);
		// W789: tools bridge — anthropic defs → OpenAI; threaded to the local
		// ladder so tool-bearing lane requests keep tool_use on the swarm legs
		// during cloud walls. Declared here: the route selection below uses it.
		const oaTools = toOpenAiTools(body.tools);
		const oaToolChoice = oaTools
			? toolChoiceToOpenAi(body.tool_choice)
			: undefined;
		let route = isCode
			? TIER_ROUTES.MEDIUM
			: score.tier === "SIMPLE"
				? TIER_ROUTES.SIMPLE
				: TIER_ROUTES.COMPLEX;
		if (el.label === "general") route = DANISH;
		if (el.label === "none") route = REASON; // best effort; note explains
		if (el.label === "cloud") route = REASON; // escalate-first when allowed; else local best-effort
		if (el.label === "reason") route = REASON; // W279: label decides placement
		if (el.label === "extract") route = TIER_ROUTES.SIMPLE;
		// W789: tool-bearing requests need a tool-capable leg — the extract
		// specialist can't emit tool_calls; the reason tier can (verified).
		if (oaTools) route = REASON;

		// ambiguity band → Kev typed-question classifier decides by use case
		// (routing table from prefs); kev down/slow ⇒ regex result stands.
		// Prompts past Kev's context window skip the serial hop (W270).
		let classifier = "";
		let kevEscalate: string | undefined;
		let preAttempts = 0;
		const band: [number, number] = prefs.kev?.ambiguity_band ?? [0.25, 0.45];
		const inBand = score.total >= band[0] && score.total <= band[1];
		const kevWanted =
			prefs.kev?.enabled &&
			(el.label === "extract" ||
				el.label === "reason" ||
				el.label === "cloud") &&
			(inBand || score.tier === "VERY_COMPLEX");
		if (kevWanted && !kevEligible(text)) classifier = "kev-skipped:long";
		else if (kevWanted) {
			const kevTrace = childTraceparent(trace.traceparent);
			const kevStarted = performance.now();
			let kevStatus: number | undefined;
			let kevFailureKind: "http" | "transport" | "decode" | undefined;
			try {
				const kr = await fetch(
					`http://127.0.0.1:${prefs.kev?.port ?? 8912}/v1/systemone`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							traceparent: kevTrace,
							"x-klh-request-id": trace.requestId,
						},
						signal: AbortSignal.timeout(4000),
						body: JSON.stringify({
							model: "kev-latest",
							state: text.slice(0, 4000),
							questions: {
								// W786: one serial hop, two decisions — the escalate
								// question rides the same kev call and prices the
								// cloud leg (operator gate: prefs.kev.escalate_gate)
								...(prefs.kev?.escalate_gate && el.label === "cloud"
									? {
											escalate: {
												type: "choice",
												instructions:
													"Does answering this well require a frontier cloud model, or is a competent local model adequate?",
												criteria: {
													cloud_worthy:
														"Deep multi-step reasoning, novel architecture, or large-context synthesis where a small local model would lose correctness",
													local_adequate:
														"Routine implementation, known patterns, mechanical work, or short-context tasks a competent local model handles",
												},
											},
										}
									: {}),
								use_case: {
									type: "choice",
									instructions: "Which use-case class is this request?",
									criteria: {
										coding: "Writing, debugging, or reviewing code",
										architecture:
											"System design, trade-offs, technical strategy",
										trading: "Stock market, positions, finance risk decisions",
										business: "Invoices, customers, business administration",
										research: "Multi-source investigation and synthesis",
										product: "Product decisions and roadmaps",
										personal: "Everyday personal assistance, email, chit-chat",
									},
								},
							},
						}),
					},
				);
				kevStatus = kr.status;
				if (!kr.ok) {
					kevFailureKind = "http";
					throw new Error("kev rejected request");
				}
				const kj = (await kr.json()) as {
					answers?: { use_case?: { choice?: string } };
				};
				const uc = kj.answers?.use_case?.choice;
				// W786: capture the escalate verdict for the cloud gate below
				kevEscalate = kj.answers?.escalate?.choice;
				const pin = uc ? prefs.routing_table?.[uc] : undefined;
				if (pin) {
					route =
						pin === 8901
							? TIER_ROUTES.MEDIUM
							: pin === 8902
								? TIER_ROUTES.SIMPLE
								: TIER_ROUTES.COMPLEX;
					classifier = `kev:${uc}`;
				}
			} catch {
				kevFailureKind ??= kevStatus === undefined ? "transport" : "decode";
				/* kev unavailable → keep regex route */
			} finally {
				preAttempts++;
				logRouting({
					event: "upstream_attempt",
					trace_id: trace.traceId,
					request_id: trace.requestId,
					attempt: preAttempts,
					span_id: kevTrace.split("-")[2],
					hop: "kev",
					port: prefs.kev?.port ?? 8912,
					status: kevStatus,
					duration_ms: Math.round(performance.now() - kevStarted),
					failure_kind: kevFailureKind,
				});
			}
		}

		// W279: Danish/multilingual → the on-demand generalist :8906 (routing
		// rule 5) — classifyELabel owns it via the general label; language beats
		// task class. The kev pin applies only to fallback-label prose below.

		let release: (() => void) | null = null;
		let handedOff = false; // a live stream owns `release` until its last byte
		const pendingCleanup: Promise<void>[] = [];
		const releasePrimary = () => {
			if (release) releaseAfterCleanup(release, pendingCleanup);
		};
		try {
			const clientMax = Math.min(body.max_tokens ?? 1024, 4096);
			const temperature = body.temperature ?? 0.7;
			// W304.2: knob-gated inbound condense (prefs.json condense.enabled,
			// default OFF — dispatch briefs are condensed at SOURCE since W334;
			// the knob pays only for interactive/CLI riders of :4000 with raw
			// prose). Classification above ran on the RAW text, so routing is
			// identical with the knob on or off — only the upstream payload
			// shrinks. User messages only: system = harness, assistant = history.
			const rawMessages = toOpenAiMessages(body);
			const inbound = applyInboundCondense(rawMessages, prefs.condense);
			const messages = inbound.messages;
			const condenseMeta: CondenseMeta | null = inbound.meta;

			let response = "";
			let finish: string | undefined;
			/** W789: tool calls captured from the local ladder's answer. */
			let resultToolCalls: OpenAiToolCall[] | undefined;
			let usedPort: number = route.port;
			let usedModel = route.model;
			let localTimings: RequestTimings | undefined;
			const note: string[] = [
				`complexity ${score.total.toFixed(2)} → ${score.tier}${isCode ? "+code" : ""}${classifier ? ` ${classifier}` : ""}`,
				`e-label ${el.label} (${el.why})`,
			];
			const errors: string[] = [];
			let attemptCount = preAttempts;
			let lastHop = "router";
			let lastStatus: number | undefined;
			let lastUpstreamId: string | undefined;
			let lastCallId: string | undefined;
			const recordAttempt = (receipt: {
				hop: string;
				traceparent: string | null;
				requestId: string | null;
				status?: number;
				durationMs: number;
				port?: number;
				attemptId?: string;
				retryAfterMs?: number;
				upstreamCallId?: string;
				upstreamRid?: string;
				failureKind?: "http" | "transport" | "decode" | "empty";
			}) => {
				attemptCount++;
				lastHop = receipt.hop;
				lastStatus = receipt.status;
				lastUpstreamId = receipt.upstreamRid;
				lastCallId = receipt.upstreamCallId;
				logRouting({
					event: "upstream_attempt",
					trace_id: trace.traceId,
					request_id: trace.requestId,
					attempt: attemptCount,
					span_id: receipt.traceparent?.split("-")[2],
					hop: receipt.hop,
					port: receipt.port,
					status: receipt.status,
					duration_ms: receipt.durationMs,
					retry_after_ms: receipt.retryAfterMs,
					upstream_call_id: receipt.upstreamCallId,
					upstream_rid: receipt.upstreamRid,
					failure_kind: receipt.failureKind,
				});
			};
			const hopFields = () => ({
				attempts: attemptCount,
				upstreamKind:
					lastHop === "buckle-gate"
						? "buckle"
						: lastHop === "litellm"
							? "litellm"
							: lastHop === "local-specialist"
								? "local"
								: "none",
				...(lastStatus !== undefined ? { upstreamStatus: lastStatus } : {}),
				...(lastUpstreamId ? { upstreamId: lastUpstreamId } : {}),
				...(lastCallId ? { callId: lastCallId } : {}),
			});
			if (condenseMeta)
				note.push(
					`condense ${condenseMeta.tier}: ${condenseMeta.rules.length} rules fired`,
				);
			const routingInfo = () => ({
				tier: score.tier,
				complexity: score.total.toFixed(3),
				category: el.label,
				port: usedPort,
				model: usedModel,
				note: note.join("; "),
				prefs: {
					cost_speed: prefs.cost_speed ?? "balanced",
					allow_cloud: prefs.allow_cloud === true,
					profile: prefs.profile ?? [],
				},
				dimensions: Object.fromEntries(
					Object.entries(score.dimensions).map(([k, v]) => [k, v.toFixed(2)]),
				),
				...(condenseMeta
					? {
							condense: {
								version: condenseMeta.version,
								tier: condenseMeta.tier,
								rules: condenseMeta.rules.length,
							},
						}
					: {}),
			});
			const logDone = (extra: Record<string, unknown>) =>
				logRouting({
					event: "request_completed",
					trace_id: trace.traceId,
					request_id: trace.requestId,
					attempts: attemptCount,
					last_hop: lastHop,
					upstream_status: lastStatus,
					upstream_rid: lastUpstreamId,
					upstream_call_id: lastCallId,
					category: el.label,
					model: usedModel,
					port: usedPort,
					duration_ms: Date.now() - startTime,
					...promptFingerprint(text),
					complexity: score.total,
					tier: score.tier,
					stream: wantStream || undefined,
					...(condenseMeta
						? {
								condense_tier: condenseMeta.tier,
								condense_rules: condenseMeta.rules.length,
							}
						: {}),
					...extra,
				});

			// selftest hook: _force_dead_port swaps the primary target while keeping
			// route identity — fallbackFor() still maps from the real route.
			// W278: env-gated — a request body must not steer production routing;
			// restart the shim with BELT_SELFTEST=1 to arm it.
			let primary = route;
			if (
				process.env.BELT_SELFTEST === "1" &&
				Number.isFinite(Number(body._force_dead_port))
			) {
				primary = {
					...route,
					port: Number(body._force_dead_port) as Specialist["port"],
					model: "selftest-dead",
				};
				note.push(`forced dead primary :${primary.port}`);
			}

			// budget policy per target model (thinking off / min budget)
			const budgetFor = (t: Specialist) => {
				const b = applyBudget(t.model, clientMax);
				if (b.note) note.push(b.note);
				return b;
			};

			let retryAfter: number | undefined;
			let coldDeferred = false;
			let cloudStatus: number | undefined;
			// W279: cloud-first serving — a cloud serving-tier decision escalates
			// BEFORE the local ladder (a stated >32k-token request on the small
			// local tiers is broken placement); on failure the ladder runs on the
			// best-effort route (REASON). One cloud attempt per request.
			let triedCloud = false;
			const tryCloud = async (wantFast: boolean): Promise<boolean> => {
				triedCloud = true;
				try {
					const c = await escalate(body, {
						maxTokens: clientMax,
						wantFast,
						traceparent: trace.traceparent,
						requestId: trace.requestId,
						preference,
						onAttempt: recordAttempt,
					});
					if (c.note) note.push(c.note);
					if (c.status && c.status >= 400) {
						cloudStatus = c.status;
						errors.push(
							`cloud HTTP ${c.status}: ${c.error ?? "upstream declined"}`,
						);
					}
					if (c.status === 429)
						retryAfter = Math.max(retryAfter ?? 0, c.retryAfterMs ?? 0);
					if (!c.text) return false;
					response = c.text;
					usedPort = 0;
					usedModel = `z.ai:${c.model}`;
					note.push("escalated → cloud(z.ai)");
					return true;
				} catch {
					note.push("cloud escalation failed");
					return false;
				}
			};
			// cloud gate + tier decision: only prefs authorize the cloud leg;
			// W786: kev's escalate verdict can keep it local (fail-open — no
			// verdict, kev down, or escalate_gate off ⇒ today's behavior)
			if (el.label === "cloud" && cloudAllowedForRequest) {
				if (kevEscalateVeto(el.label, kevEscalate))
					note.push("kev escalate-gate: kept local");
				else await tryCloud(true);
			}
			// A successful cloud-first request never enters the local ladder and
			// must not occupy one of its specialist slots. Acquire only if the
			// local leg will actually run, including after a failed cloud attempt.
			if (!response) {
				release = admission.tryAcquire(route.port);
				if (!release && cloudAllowedForRequest && !triedCloud) {
					// W1071 (owner doctrine 2026-10-20): a local cap-refusal is an
					// internal signal, never an upstream one — spill to cloud when
					// prefs authorize it; 429 only after cloud also declines.
					await tryCloud(score.tier !== "VERY_COMPLEX");
				}
				if (!release && !response) {
					logDone({
						outcome: "overloaded",
						http_status:
							cloudStatus !== undefined
								? cloudStatus === 429
									? 429
									: 502
								: 429,
						cap: admission.capOf(route.port),
					});
					if (cloudStatus !== undefined)
						return stamped(
							upstreamDecline(cloudStatus, retryAfter, [...note, ...errors]),
							lastHop,
							{
								refusal:
									cloudStatus === 429 ? "upstream_rate_limit" : "upstream_http",
								...hopFields(),
							},
						);
					return stamped(overloaded(route.port, admission), "local_admission", {
						refusal: "local_capacity",
						...hopFields(),
					});
				}
			}
			if (wantStream && !response) {
				// streamed: TTFT = the specialist's first token, not the full answer
				const opened = await ladder(
					route,
					primary,
					async (t) => {
						const b = budgetFor(t);
						const local = await openLocalStream(
							t,
							messages,
							b.maxTokens,
							temperature,
							{
								extra: b.extra,
								tools: oaTools,
								toolChoice: oaToolChoice,
								startedAt: t0,
								traceparent: trace.traceparent,
								requestId: trace.requestId,
								preference,
								onAttempt: recordAttempt,
							},
						);
						if (!local.ok && local.cleanup && t.port === route.port)
							pendingCleanup.push(local.cleanup);
						return local;
					},
					note,
					errors,
				);
				usedPort = opened.used.port;
				usedModel = opened.used.model;
				if (opened.retryAfterMs !== undefined)
					retryAfter = Math.max(retryAfter ?? 0, opened.retryAfterMs);
				coldDeferred ||= opened.coldDeferred === true;
				if (opened.result.ok) {
					const routing = routingInfo();
					const fbRelease = opened.fbRelease;
					const stream = anthropicSseFromOpenAi(
						opened.result.body,
						{
							id: `msg_${route.role}_${Date.now()}`,
							model: body.model,
							routing,
							startedAt: t0,
							openedAt: opened.result.openedAt,
						},
						(r) => {
							fbRelease?.();
							releasePrimary();
							logDone({
								outcome: r.error
									? "stream-error"
									: r.chars
										? undefined
										: "empty",
								finish: r.finish,
								http_status: 200,
								...r.timings,
							});
						},
					);
					handedOff = true;
					return stamped(
						new Response(stream, { headers: sseHeaders(routing) }),
						lastHop,
						hopFields(),
					);
				}
			} else if (!response && !wantStream) {
				const got = await ladder(
					route,
					primary,
					(t) => {
						const b = budgetFor(t);
						return viaLocal(t, messages, b.maxTokens, temperature, {
							extra: b.extra,
							tools: oaTools,
							toolChoice: oaToolChoice,
							startedAt: t0,
							traceparent: trace.traceparent,
							requestId: trace.requestId,
							preference,
							onAttempt: recordAttempt,
						});
					},
					note,
					errors,
				);
				got.fbRelease?.();
				usedPort = got.used.port;
				usedModel = got.used.model;
				if (got.retryAfterMs !== undefined)
					retryAfter = Math.max(retryAfter ?? 0, got.retryAfterMs);
				coldDeferred ||= got.coldDeferred === true;
				localTimings = got.result.timings;
				if (got.result.ok) {
					response = got.result.response;
					finish = got.result.finish;
					resultToolCalls = got.result.toolCalls;
				}
			}

			// cloud escalation — prefs-gated, never in cost mode. W279:
			// cloud-decided requests escalated FIRST (tryCloud above); this tail
			// hop covers the fallback when the local ladder fails. W1071 (owner
			// doctrine 2026-10-20): default max throughput — every ladder failure
			// spills to cloud; prefs are the opt-in throttle, upstream 429 +
			// Retry-After are the reactive one.
			if (
				!response &&
				!(resultToolCalls && resultToolCalls.length > 0) &&
				cloudAllowedForRequest &&
				!triedCloud
			) {
				await tryCloud(score.tier !== "VERY_COMPLEX");
			}

			if (!response && !(resultToolCalls && resultToolCalls.length > 0)) {
				// A cold local leg is a retryable capacity refusal, not an upstream
				// provider failure. Preserve its backoff hint for the caller.
				if (retryAfter !== undefined) {
					logDone({
						outcome: coldDeferred ? "cold-model" : "upstream-429",
						http_status: 429,
					});
					return stamped(
						upstreamDecline(429, retryAfter, [...note, ...errors]),
						lastHop,
						{
							refusal: coldDeferred ? "local_cold" : "upstream_rate_limit",
							...hopFields(),
						},
					);
				}
				logDone({ outcome: "empty", http_status: 502 });
				return stamped(
					Response.json(
						{
							type: "error",
							error: {
								type: "api_error",
								message: `router: all routes empty (${[...note, ...errors].join("; ")})`,
							},
						},
						{ status: 502 },
					),
					lastHop,
					{ refusal: "all_routes_empty", ...hopFields() },
				);
			}

			// W257 `_server_timings`: the used leg's prefill window when a local
			// specialist answered; total always. Fields the leg couldn't observe
			// (ttft/decode on buffered legs) stay absent.
			const timings: RequestTimings = {
				total_ms: Math.round(performance.now() - t0),
				...(localTimings?.prefill_ms !== undefined
					? { prefill_ms: localTimings.prefill_ms }
					: {}),
			};
			logDone({
				http_status: 200,
				escalated: usedPort === 0 ? "z.ai" : undefined,
				finish,
				...timings,
			});
			const id = `msg_${route.role}_${Date.now()}`;
			const routing = routingInfo();
			if (wantStream)
				return stamped(
					new Response(
						anthropicSseFromText(
							response,
							{ id, model: body.model, routing, timings },
							finish,
						),
						{ headers: sseHeaders(routing) },
					),
					lastHop,
					hopFields(),
				);
			// W789: tool_use blocks after any text; stop_reason tool_use wins.
			const content: Array<Record<string, unknown>> = [
				...(response ? [{ type: "text", text: response }] : []),
				...(resultToolCalls ?? []).map((c) => ({
					type: "tool_use",
					id: c.id,
					name: c.function.name,
					input: parseToolArgs(c.function.arguments),
				})),
			];
			return stamped(
				Response.json(
					{
						id,
						type: "message",
						role: "assistant",
						model: body.model,
						content,
						stop_reason:
							resultToolCalls && resultToolCalls.length > 0
								? "tool_use"
								: stopReason(finish),
						usage: { input_tokens: 0, output_tokens: 0 },
						_routing: routing,
						_server_timings: timings,
					},
					{ headers: condenseResponseHeaders(routing) },
				),
				lastHop,
				hopFields(),
			);
		} finally {
			if (!handedOff) releasePrimary();
		}
	},
});

console.log(
	`router-shim v3 (complexity + prefs + escalation) on :${ROUTER_PORT}`,
);
for (const [tier, r] of Object.entries(TIER_ROUTES)) {
	console.log(
		`  ${tier.padEnd(13)} → :${r.port} ${r.model.replace("mlx-community/", "")}`,
	);
}
console.log(
	`  code → :${CODE.port} · non-SIMPLE prose → :${REASON.port} · SIMPLE → :${EXTRACT.port}`,
);
console.log(
	`  danish/multilingual → :${DANISH.port} (on-demand, spawned on first request)`,
);
console.log(
	`  cloud escalation: allow_cloud=true (COMPLEX+ only, off in cost mode)`,
);
