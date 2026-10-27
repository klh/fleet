// src/wire-stamp.ts — W136 wire-header stamping on responses
// (x-belt-rid/route/error) + hop headers; SSE header pass-through.

import type { TransportEvidence } from "@klh/telemetry/src/transport-evidence.ts";
import { stampHopHeaders } from "@klh/telemetry/src/http-trace.ts";
import { PREFER_HEADER } from "@klh/telemetry/src/prefer-header.ts";
import type { CandidateRow } from "./candidates.ts";
import { latencyClass } from "./decide.ts";
import { settleInflight } from "./gov/inflight.ts";
import type { Ctx } from "./request-context.ts";
import { stampServedIdentity } from "./served-identity.ts";

export const SSE_HEADERS = (h: Headers): Headers => {
	const out = new Headers();
	for (const [k, v] of h) {
		if (
			k === "content-length" ||
			k === "transfer-encoding" ||
			k === "connection"
		)
			continue;
		out.set(k, v);
	}
	return out;
};

const HEADERS_JSON = (h: Record<string, string>): Headers => {
	const out = new Headers();
	for (const [k, v] of Object.entries(h)) out.set(k, v);
	return out;
};

/** Stamp the W136 wire headers on a response without touching its body:
 *  x-belt-rid always; x-belt-route (single-line JSON: rid, target, decision,
 *  latency_class, tier) on every router-decided response; x-belt-error on
 *  errors. */
export function stamped(
	resp: Response,
	ctx: Ctx,
	route: {
		decision: string;
		row?: CandidateRow;
		streaming?: boolean;
		code?: string | null;
		refusal?:
			| "buckle"
			| "upstream"
			| "bridged-upstream"
			| "network"
			| "cooldown";
		upstreamStatus?: number;
		attempts?: number;
		requestId?: string;
		callId?: string;
		upstreamKind?: string;
		transportTimeoutPhase?: TransportEvidence["timeoutPhase"];
	},
): Response {
	const payload: Record<string, unknown> = {
		rid: ctx.rid,
		decision: route.decision,
	};
	if (route.row) {
		payload.target = {
			kind: route.row.kind,
			host: route.row.host,
			port: route.row.port,
			model: route.row.model,
		};
		payload.latency_class = latencyClass(route.row.estimate_ms);
	}
	if (ctx.tier) payload.tier = ctx.tier;
	if (ctx.lane) payload.lane = ctx.lane;
	if (route.attempts !== undefined) payload.attempts = route.attempts;
	if (route.refusal) payload.refusal = route.refusal;
	const hs = HEADERS_JSON({
		"x-belt-rid": ctx.rid,
		"x-belt-route": JSON.stringify(payload),
		...(route.code ? { "x-belt-error": route.code } : {}),
	});
	stampHopHeaders(hs, {
		service: "buckle",
		hop: ctx.hop.peer ? "relay" : "ingress",
		traceId: ctx.trace.traceparent.split("-")[1],
		refusal: route.refusal,
		attempts: route.attempts,
		upstreamStatus: route.upstreamStatus,
		upstreamKind: route.upstreamKind,
		transportTimeoutPhase: route.transportTimeoutPhase,
		upstreamId: route.requestId,
		callId: route.callId,
	});
	for (const [k, v] of hs) resp.headers.set(k, v);
	stampServedIdentity(
		resp.headers,
		ctx.served ?? {
			model: null,
			provider: null,
			providerProfile: null,
			evidence: "unknown",
		},
	);
	resp.headers.delete(PREFER_HEADER);
	if (ctx.preference) resp.headers.set(PREFER_HEADER, ctx.preference);
	settleInflight(ctx, resp, route); // W1259: hold streams, settle the rest
	return resp;
}
