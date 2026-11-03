// src/request-context.ts — the per-request context (Ctx) with its rid
// mint, W921 traffic-kind classification, and lane-observation publishing.

import type { AcctContext } from "./account-policy.ts";
import type { AppDeps } from "./app-deps.ts";
import type { RouteSelection } from "./decide.ts";
import { principalOf } from "./gov/federation.ts";
import type { RouteHint } from "./hints.ts";
import type { HopContext } from "./hop.ts";
import type { HopContract } from "./hop-deadline.ts";
import type { ObservationData, ObservationType } from "./observe.ts";
import type { ServedIdentity } from "./served-identity.ts";
import type { TraceContext } from "./trace.ts";
import type { Dialect } from "./upstreams.ts";

/** Short request id — the audit join key echoed as x-belt-rid. */
export function newRid(): string {
	return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** W921 traffic kind: a request is READINESS traffic only when a
 *  root-authenticated principal carries the healthcheck's
 *  `x-klh-traffic: readiness` mark — a lane key (or any non-root
 *  credential) with that header stays inference, and root traffic
 *  without the mark stays inference too (break-glass stays honest).
 *  Gate-off posture (no principal) is never readiness. */
export function trafficKindOf(req: Request): string {
	if (req.headers.get("x-klh-traffic") !== "readiness") return "inference";
	return principalOf(req)?.kind === "root" ? "readiness" : "inference";
}

/** W2256: safe bounded audit token — a short non-secret identifier (group,
 *  provider pin). Empty/oversized/absent collapses to null (unknown, never
 *  a zero-length stand-in); never carries URLs or credentials. */
export function safeAuditToken(v: string | null | undefined): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim().slice(0, 128);
	return t.length === 0 ? null : t;
}

/** W2256: safe bounded canonical request path for audit rows — query
 *  strings stripped, traversal rejected, capped; the raw URL never rides. */
export function safeAuditPath(v: string | null | undefined): string | null {
	if (typeof v !== "string") return null;
	const t = v.split("?")[0]?.trim().slice(0, 256) ?? "";
	return t.length === 0 || t.includes("..") ? null : t;
}

export interface Ctx {
	demand?: boolean;
	served?: ServedIdentity;
	key: string;
	group: string;
	model: string;
	dialect: Dialect;
	rid: string;
	/** W1 lane attribution: the /w/<slug> slug ('' on bare paths). */
	lane: string;
	hintRaw: string;
	hint: RouteHint | null;
	tier: string;
	t0: number;
	sel?: RouteSelection;
	/** W1265.1: the resolved account context (undefined = policy inert for
	 *  this request — no class table, no pin). */
	acct?: AcctContext;
	/** W5: the request declared `condense-in` in its x-belt-aids stanza. */
	condenseIn: boolean;
	/** W237: packet-prefix key (null = no packet block, no affinity). */
	affKey: string | null;
	/** W926: keyed digest of the effective delivered prefix (post-alignment
	 *  body), null when the fingerprint ledger is unwired. */
	prefixFp: string | null;
	/** W450 bounded RPC admission: the slot release fn while this request's
	 *  upstream RPC is in flight (set in runExecute, released at drain). */
	slot?: () => void;
	/** W461 stage 1: request trace context (inbound traceparent or a fresh
	 *  root; baggage filtered to the fleet allowlist). */
	trace: TraceContext;
	/** W706: hop attribution — origin (self when entered here) + the
	 *  immediate peer (null = entered the fleet at this hub). */
	hop: HopContext;
	/** W1118.1: the admitted (or freshly rooted) hop contract this hop
	 *  threads onto every fleet-leg attempt. Set after body admission —
	 *  refusals before the model parse never hold one. */
	hopContract?: HopContract;
	/** W921 traffic kind: 'readiness' when a ROOT-authenticated request
	 *  carries the x-klh-traffic: readiness mark (the healthcheck sidecar's
	 *  synthetic full-chain poll); 'inference' otherwise. */
	trafficKind: string;
	/** W1106: the request's abort signal — the honest downstream_cancel
	 *  evidence for stream receipts (Bun surfaces destination death lazily:
	 *  a pipeTo only rejects on the NEXT failed write, so a quiet abort
	 *  after the last chunk would otherwise bank as upstream_eof). */
	signal?: AbortSignal;
	/** Canonicalized executor intent; diagnostic only, never a route hint. */
	preference: string | null;
	/** W2256 wire-deny provenance — set at the ingress seam BEFORE routing, so
	 *  every audit row (denials included) carries them. request_path = the
	 *  canonical path after lane/named-base unwrapping (safeAuditPath-bounded,
	 *  never the raw URL); allow_cross = bridging in play at decide time;
	 *  provider_pin = the named-base catalog pin (null = unpinned). */
	auditPath: string | null;
	auditAllowCross: boolean | null;
	auditProviderPin: string | null;
	/** W461 stage 2: set once the admitted observation is published —
	 *  ended events only ride admitted requests. */
	admitted?: boolean;
}

/** W461 stage 2: publish one lane observation for this request. Inert
 *  unless the outbox is wired (BUCKLE_OBSERVATIONS_PATH). */
export function observe(
	deps: AppDeps,
	ctx: Ctx,
	type: ObservationType,
	extra?: Partial<ObservationData>,
): void {
	deps.observations?.emit(type, {
		rid: ctx.rid,
		lane: ctx.lane,
		actor: ctx.key,
		dialect: ctx.dialect,
		model: ctx.model,
		traceparent: ctx.trace.traceparent,
		origin: ctx.hop.origin,
		...(ctx.hop.peer ? { peer: ctx.hop.peer } : {}),
		...extra,
	});
}
