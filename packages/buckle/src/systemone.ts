// src/systemone.ts — W1120: the typed SystemOne ingress (POST /v1/systemone).
// Owner ruling decision.single-buckle-inference: kev-class typed decisions
// ride Buckle like every other inference hop — authenticated (the gate's
// proxy class), admitted (the shared in-flight bound), traced (W1086 hop
// receipts), and deadline/cancel-aware (the caller's signal + a configured
// timeout). The upstream target is OPERATOR CONFIG (gateway.systemone in
// routing-policy.json): missing target or missing key material fails CLOSED
// with a typed local refusal and zero outbound — no belt-style direct :8912
// bypass lives anywhere in-fleet once callers repoint here.
import { z } from "zod";
import type { AppDeps } from "./app-deps.ts";
import { problem } from "./citizenship.ts";
import { readBoundedJson } from "./ingress-body.ts";
import { newTraceparent, parseTraceparent } from "./trace.ts";

/** Default whole-exchange ceiling for the upstream decision call. */
export const SYSTEMONE_TIMEOUT_MS = 10_000;

const SYSTEMONE_GROUP = "systemone";

/** The wire shape every kev-class caller already speaks (kev.ts live
 *  contract): typed choice questions in, typed answers out. Schema law:
 *  named zod schema, safeParse, drift fails LOUD (400 with the parse why). */
export const SystemOneRequestSchema = z.object({
	state: z.string().min(1).max(8_000),
	questions: z
		.record(
			z.string().min(1).max(64),
			z.object({
				type: z.literal("choice"),
				instructions: z.string().max(8_000).optional(),
				criteria: z
					.record(z.string().min(1).max(256), z.string().max(4_000))
					.refine(
						(o) =>
							Object.keys(o).length >= 1 && Object.keys(o).length <= 16,
						"criteria: 1..16 options",
					),
			}),
		)
		.refine(
			(q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 16,
			"questions: 1..16",
		),
});
export type SystemOneRequest = z.infer<typeof SystemOneRequestSchema>;

/** The upstream answer for one question — choice must be one of the offered
 *  criteria; anything else is a malformed pass, never relayed as success. */
const UpstreamAnswerSchema = z.object({
	choice: z.string().min(1),
	confidence: z.number().min(0).max(1).optional(),
	probabilities: z.record(z.string(), z.number()).optional(),
});

const UpstreamResponseSchema = z.object({
	model: z.string().optional(),
	answers: z.record(z.string(), UpstreamAnswerSchema),
	usage: z
		.object({
			input_tokens: z.number().optional(),
			output_tokens: z.number().optional(),
		})
		.optional(),
	latency_ms: z.number().optional(),
});

const ridsafe = (n: number): string =>
	`${Date.now().toString(36)}${Math.random().toString(36).slice(2, n)}`;

/** POST /v1/systemone — one typed-decision pass against the configured
 *  kev-class upstream. Semantic success (a well-formed answer set) and every
 *  failure kind land as a route_audit decision row + a W1086 hop receipt on
 *  the trace, so the board sees the systemone hop like any other. */
export async function systemoneRoute(
	req: Request,
	deps: AppDeps,
): Promise<Response> {
	const hubId = deps.hubId ?? "local";
	const t0 = Date.now();
	const rid = `r${ridsafe(6)}`;
	const traceparent =
		parseTraceparent(req.headers.get("traceparent")) ?? newTraceparent();
	const traceId = traceparent.split("-")[1] ?? "";
	const cfg = deps.systemonePolicy;
	// Fail closed: no configured target means this gateway carries no
	// systemone traffic — a typed local refusal, zero outbound.
	if (!cfg?.url || cfg.url.length === 0)
		return refuse(deps, rid, traceId, t0, 503, "systemone_unconfigured",
			"gateway.systemone.url is not configured — SystemOne ingress is disabled on this deployment");
	const keyEnv = cfg.api_key_env;
	if (!keyEnv || keyEnv.length === 0)
		return refuse(deps, rid, traceId, t0, 503, "systemone_unconfigured",
			"gateway.systemone.api_key_env is not configured — SystemOne refuses to forward unauthenticated");
	const key = process.env[keyEnv] ?? "";
	if (key.length === 0)
		return refuse(deps, rid, traceId, t0, 503, "systemone_no_key",
			`env ${keyEnv} is unset — no upstream credential, refusing (fail closed)`);
	const read = await readBoundedJson(req, deps.ingressBodyTimeoutMs);
	if (!read.ok)
		return problem({
			status: read.status,
			code: read.code,
			why: read.why,
		});
	const parsed = SystemOneRequestSchema.safeParse(read.body);
	if (!parsed.success)
		return problem({
			status: 400,
			code: "buckle.systemone_bad_request",
			why: `malformed SystemOne request: ${z.prettifyError(parsed.error)}`,
		});
	// One shared admission slot — the systemone hop never queues blindly past
	// the in-flight bound (W450 law, same as the proxy path).
	const release = deps.admission?.tryAcquire(SYSTEMONE_GROUP) ?? null;
	if (release === null && deps.admission) {
		deps.sm
			.counter(
				"buckle_admission_refusals_total",
				"Proxy requests refused at the in-flight bound.",
			)
			.inc({ group: SYSTEMONE_GROUP });
		return problem({
			status: 429,
			code: "buckle.overloaded",
			why: `gateway at max in-flight for ${SYSTEMONE_GROUP} (${String(deps.admission.capOf(SYSTEMONE_GROUP))}) — admission refused locally (W450)`,
			headers: { "retry-after": String(deps.admission.retryAfterS) },
		});
	}
	try {
		return await forwardUpstream(req, deps, {
			cfg,
			key,
			keyEnv,
			body: parsed.data,
			rid,
			traceId,
			traceparent,
			t0,
		});
	} finally {
		release?.();
	}
}

/** The configured SystemOne upstream block (gateway.systemone). */
export interface SystemOneConfig {
	url: string;
	api_key_env: string;
	timeout_ms?: number;
}

/** The upstream exchange + semantic validation + receipt. */
async function forwardUpstream(
	req: Request,
	deps: AppDeps,
	arg: {
		cfg: SystemOneConfig;
		key: string;
		keyEnv: string;
		body: SystemOneRequest;
		rid: string;
		traceId: string;
		traceparent: string;
		t0: number;
	},
): Promise<Response> {
	const { cfg, rid, traceId, traceparent, t0 } = arg;
	const origin = cfg.url;
	let res: Response;
	try {
		res = await fetch(`${origin.replace(/\/$/, "")}/v1/systemone`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${arg.key}`,
				traceparent,
				"x-klh-request-id": rid,
			},
			body: JSON.stringify({ state: arg.body.state, questions: arg.body.questions }),
			// Deadline + cancel aware: the caller's disconnect aborts the
			// upstream exchange; the configured ceiling bounds a hung one.
			signal: AbortSignal.any([
				req.signal,
				AbortSignal.timeout(cfg.timeout_ms ?? SYSTEMONE_TIMEOUT_MS),
			]),
		});
	} catch (e) {
		const timedOut = e instanceof Error && e.name === "TimeoutError";
		const canceled = e instanceof Error && e.name === "AbortError";
		receipt(deps, {
			rid,
			traceId,
			origin,
			status: null,
			layer: "network",
			durationMs: Date.now() - t0,
			refusalOrigin: null,
			retryAfterMs: null,
		});
		settle(deps, rid, traceId, t0, false, timedOut ? "upstream_timeout" : canceled ? "client_abort" : "network");
		if (canceled) return new Response(null, { status: 499 });
		return problem({
			status: timedOut ? 504 : 502,
			code: timedOut ? "buckle.systemone_timeout" : "buckle.systemone_unreachable",
			why: timedOut
				? `SystemOne upstream did not answer within ${String(cfg.timeout_ms ?? SYSTEMONE_TIMEOUT_MS)}ms`
				: "SystemOne upstream unreachable",
		});
	}
	const durationMs = Date.now() - t0;
	// Upstream budget refusals relay as-is (the upstream's budget is the
	// client's information); everything else non-ok is a typed 502.
	if (res.status === 429) {
		receipt(deps, { rid, traceId, origin, status: 429, layer: "upstream", durationMs, refusalOrigin: "upstream", retryAfterMs: retryAfterOf(res) });
		settle(deps, rid, traceId, t0, false, "rate_limited");
		const ra = res.headers.get("retry-after");
		return problem({
			status: 429,
			code: "buckle.systemone_rate_limited",
			why: "SystemOne upstream rate-limited the decision pass",
			...(ra !== null ? { headers: { "retry-after": ra } } : {}),
		});
	}
	if (!res.ok) {
		receipt(deps, { rid, traceId, origin, status: res.status, layer: "upstream", durationMs, refusalOrigin: "upstream", retryAfterMs: null });
		settle(deps, rid, traceId, t0, false, "upstream_error");
		return problem({
			status: 502,
			code: "buckle.systemone_upstream",
			why: `SystemOne upstream answered ${String(res.status)}`,
		});
	}
	let wire: unknown;
	try {
		wire = await res.json();
	} catch {
		receipt(deps, { rid, traceId, origin, status: res.status, layer: "upstream", durationMs, refusalOrigin: "upstream", retryAfterMs: null });
		settle(deps, rid, traceId, t0, false, "malformed_decision");
		return malformed();
	}
	const parsed = UpstreamResponseSchema.safeParse(wire);
	if (!parsed.success) {
		receipt(deps, { rid, traceId, origin, status: res.status, layer: "upstream", durationMs, refusalOrigin: "upstream", retryAfterMs: null });
		settle(deps, rid, traceId, t0, false, "malformed_decision");
		return malformed();
	}
	// Semantic success demands EVERY question answered with a choice from
	// its own criteria set — a partial or out-of-set answer is a malformed
	// pass (kev.ts caller law), relayed as a typed 502, never as success.
	for (const [id, q] of Object.entries(arg.body.questions)) {
		const a = parsed.data.answers[id];
		if (!a || !(a.choice in q.criteria)) {
			receipt(deps, { rid, traceId, origin, status: res.status, layer: "upstream", durationMs, refusalOrigin: "upstream", retryAfterMs: null });
			settle(deps, rid, traceId, t0, false, "malformed_decision");
			return malformed();
		}
	}
	receipt(deps, { rid, traceId, origin, status: res.status, layer: "upstream", durationMs, refusalOrigin: null, retryAfterMs: null });
	settle(deps, rid, traceId, t0, true, null);
	return Response.json({
		model: parsed.data.model ?? "kev-latest",
		answers: parsed.data.answers,
		usage: parsed.data.usage ?? {},
		latency_ms: parsed.data.latency_ms ?? durationMs,
	});
}

const malformed = (): Response =>
	problem({
		status: 502,
		code: "buckle.systemone_malformed",
		why: "SystemOne upstream returned a decision outside the offered criteria — refusing to relay",
	});

const retryAfterOf = (res: Response): number | null => {
	const raw = res.headers.get("retry-after");
	if (raw === null) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n * 1000) : null;
};

/** W1086 upstream hop receipt — the systemone hop is first-class on the
 *  trace, same as any ladder attempt. */
function receipt(
	deps: AppDeps,
	arg: {
		rid: string;
		traceId: string;
		origin: string;
		status: number | null;
		layer: "network" | "upstream";
		durationMs: number;
		refusalOrigin: "upstream" | null;
		retryAfterMs: number | null;
	},
): void {
	try {
		deps.ledger.auditAttempt({
			rid: arg.rid,
			traceId: arg.traceId,
			ordinal: 1,
			service: "buckle",
			hop: "systemone",
			candidate: arg.origin,
			status: arg.status,
			refusal: null,
			layer: arg.layer,
			durationMs: arg.durationMs,
			retryAfterMs: arg.retryAfterMs,
			upstreamId: null,
			callId: null,
			refusalOrigin: arg.refusalOrigin,
		});
	} catch {
		// a failed receipt never fails the route (belt precedent)
	}
}

/** Semantic settle: one route_audit decision row per pass naming success or
 *  the failure kind, so the ledger answers "did the systemone hop work". */
function settle(
	deps: AppDeps,
	rid: string,
	traceId: string,
	t0: number,
	ok: boolean,
	kind: string | null,
): void {
	try {
		deps.ledger.auditDecision({
			rid,
			requested_group: "systemone",
			trace_id: traceId,
			ts: new Date().toISOString(),
			actor: "systemone",
			lane: "",
			dialect: "systemone",
			hint: "",
			candidates_seen: 1,
			candidates_top: "systemone",
			target_kind: "local",
			target_host: null,
			target_port: null,
			target_model: null,
			decision: ok ? "policy" : "errored",
			latency_class: "unproven",
			tier: "",
			allow_cloud: false,
			error_code: kind,
			why: kind ?? "typed decision delivered",
			hop: "origin",
		});
		deps.sm
			.counter(
				"buckle_systemone_decisions_total",
				"SystemOne typed-decision passes by outcome.",
			)
			.inc({ outcome: ok ? "ok" : (kind ?? "error") });
	} catch {
		// never fails the route
	}
}

/** The fail-closed refusal + its settle row (missing target/key). */
function refuse(
	deps: AppDeps,
	rid: string,
	traceId: string,
	t0: number,
	status: number,
	code: string,
	why: string,
): Response {
	settle(deps, rid, traceId, t0, false, code);
	return problem({ status, code: `buckle.${code}`, why });
}
