// src/request-context.ts — the per-request context (Ctx) with its rid
// mint, W921 traffic-kind classification, and lane-observation publishing.

import type { AcctContext } from "./account-policy.ts";
import type { AppDeps } from "./app-deps.ts";
import type { RouteSelection } from "./decide.ts";
import { principalOf } from "./gov/federation.ts";
import type { RouteHint } from "./hints.ts";
import type { HopContext } from "./hop.ts";
import type { ObservationData, ObservationType } from "./observe.ts";
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

export interface Ctx {
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
