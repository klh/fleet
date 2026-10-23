// src/citizenship.ts — buckle's face of the shared HTTP-citizenship kit
// (packages/telemetry/src/http-kit.ts, W1238.5): problem+json bodies carry
// the stable buckle.* code in `code` plus the shared semantic `kind`, method
// introspection (OPTIONS 204, 405 + Allow) off ONE route table, and the
// rate-limit header trio in both families. The gate (gov/middleware.ts), the
// wire handlers, the admin API and servicemon all code to this module — one
// source of truth per pattern; the wire shape and the kind vocabulary live
// in the kit.
import { problem as kitProblem } from "../../telemetry/src/http-kit.ts";
import type { SemanticKind } from "../../telemetry/src/http-kit.ts";

export const PROBLEM_SLUGS: Record<number, string> = {
	400: "bad_request",
	401: "authentication_error",
	403: "permission_error",
	404: "not_found",
	405: "method_not_allowed",
	409: "state_conflict",
	422: "invalid_request",
	429: "rate_limit_error",
	500: "internal_error",
	502: "upstream_error",
	503: "service_unavailable",
	504: "upstream_timeout",
};

export interface ProblemInput {
	status: number;
	/** Semantic kind (the kit's vocabulary). Defaults from the status. */
	kind?: SemanticKind;
	/** Stable machine code — buckle.* for the gate/admin family, the W140
	 *  route codes (bad_hint, no_healthy_fit, cloud_forbidden, no_route)
	 *  for router refusals. Never renamed, only added to. */
	code: string;
	why: string;
	instance?: string;
	next?: string[];
	challenge?: string;
	headers?: Record<string, string>;
}

/** RFC 9457 problem+json with the fleet extensions: `code` (stable machine
 *  code), `why` (human detail), `kind` (the shared semantic kind, identical
 *  at every hop) and `agent_next_steps` (machine-actionable recovery).
 *  Delegates to the kit's ONE builder — buckle passes its identity only. */
export function problem(p: ProblemInput): Response {
	return kitProblem({
		service: "buckle",
		status: p.status,
		kind: p.kind,
		code: p.code,
		why: p.why,
		instance: p.instance,
		next: p.next,
		challenge: p.challenge,
		headers: p.headers,
	});
}

/** The wire route table: path → Allow value. null = unknown path (404).
 *  /status and /metrics live here too even though servicemon serves them
 *  outside the gate — the table is the one truth about what exists. */
export function allowOf(path: string): string | null {
	if (path === "/repo-policy/manifest") return "GET, OPTIONS";
	if (path === "/health" || path === "/v1/models") return "GET, HEAD, OPTIONS";
	if (path === "/status" || path === "/metrics") return "GET, HEAD, OPTIONS";
	if (path === "/.well-known/jwks.json") return "GET, HEAD, OPTIONS";
	if (
		path === "/v1/chat/completions" ||
		path === "/v1/messages" ||
		path === "/v1/messages/count_tokens" ||
		path === "/v1/responses" ||
		path === "/aids/preseed" ||
		path === "/repo-policy/check"
	)
		return "POST, OPTIONS";
	if (
		path === "/aids/status" ||
		path === "/aids/rollup" ||
		path === "/aids/events" ||
		path === "/pipeline/in" ||
		path === "/v1/fleet/whoami" ||
		/^\/pipeline\/in\/\S+$/.test(path)
	)
		return "GET, HEAD, OPTIONS";
	if (path === "/v1/admin/keys" || path === "/v1/admin/teams")
		return "GET, POST, OPTIONS";
	if (path === "/v1/admin/spokes") return "GET, OPTIONS";
	// W824 per-request inspection: read-only admin surface (HEAD rides the
	// spokes precedent — GET-class only, no body variants).
	if (path === "/v1/admin/requests") return "GET, OPTIONS";
	if (path === "/v1/admin/metrics") return "GET, OPTIONS";
	if (path === "/v1/admin/traces") return "GET, OPTIONS";
	if (path === "/v1/admin/observations") return "GET, OPTIONS";
	if (path === "/v1/admin/spokes/enroll") return "POST, OPTIONS";
	if (
		path === "/v1/admin/keys/verify" ||
		path === "/v1/admin/budgets/flush" ||
		/^\/v1\/admin\/keys\/[0-9a-f]{12}\/revoke$/.test(path)
	)
		return "POST, OPTIONS";
	if (path === "/v1/admin/budgets") return "GET, HEAD, OPTIONS";
	if (path === "/federation" || path.startsWith("/federation/"))
		return "GET, POST, OPTIONS";
	return null;
}

/** OPTIONS → 204 + Allow (CORS preflights never carry credentials, so the
 *  gate answers these pre-auth). */
export function options204(allow: string): Response {
	return new Response(null, { status: 204, headers: { allow } });
}

/** W1 lane attribution: the optional `/w/<slug>` prefix on the LLM ingress
 *  (caveman adopt 1) — the per-lane attribution axis. Slug grammar is
 *  deliberately narrow; anything else is not a lane prefix and routes as
 *  itself (404 if it matches nothing). The prefix is buckle-front-only:
 *  stripped before any upstream dispatch, kept in the audit row. */
export function lanePrefixOf(path: string): { lane: string; path: string } {
	const m = /^\/w\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.+)$/.exec(path);
	if (m === null) return { lane: "", path };
	return { lane: m[1] ?? "", path: m[2] ?? "" };
}

/** Known path, wrong method → 405 + Allow, problem+json body. */
export function methodNotAllowed(path: string): Response {
	const allow = allowOf(path) ?? "OPTIONS";
	return problem({
		status: 405,
		code: "buckle.method_not_allowed",
		why: `allows: ${allow}`,
		instance: path,
		headers: { allow },
	});
}

export interface RateLimitView {
	limit: number;
	remaining: number;
	/** Seconds until the minute window rolls (IETF draft Reset). */
	resetS: number;
	/** Unix epoch seconds of the window's end (de-facto x- family Reset). */
	resetEpochS: number;
	/** RateLimit-Policy value: the govdb budget name + quota. */
	policy: string;
}

/** Both header families, always together — RateLimit-* (IETF draft, Reset =
 *  seconds) and x-ratelimit-* (de-facto, Reset = epoch of window end). */
export function stampRateLimit(h: Headers, v: RateLimitView): void {
	const limit = String(v.limit);
	const remaining = String(Math.max(0, v.remaining));
	h.set("ratelimit-limit", limit);
	h.set("ratelimit-remaining", remaining);
	h.set("ratelimit-reset", String(v.resetS));
	h.set("ratelimit-policy", v.policy);
	h.set("x-ratelimit-limit", limit);
	h.set("x-ratelimit-remaining", remaining);
	h.set("x-ratelimit-reset", String(v.resetEpochS));
}
