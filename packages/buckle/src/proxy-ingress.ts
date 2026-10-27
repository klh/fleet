// src/proxy-ingress.ts — the proxy ingress: request context, body read,
// wire aids, account-policy verdict, routing decision + entitlement scope.

import {
	applyAccountPolicy,
	preferAfterScope,
	REPO_CLAIM_HEADER,
	scopeSelection,
} from "./account-policy.ts";
import { applyWireAids } from "./aids-routes.ts";
import { affKeyOf } from "./affinity.ts";
import { scoreComplexity, textFromMessages } from "./complexity.ts";
import { principalOf } from "./gov/federation.ts";
import { beginInflight } from "./gov/inflight.ts";
import { hintFromHeaders } from "./hints.ts";
import { hopFromBaggage, laneFromBaggage } from "./hop.ts";
import {
	INGRESS_BODY_TIMEOUT_MS,
	IngressBodyError,
	MAX_REQUEST_BODY_BYTES,
	readIngressJson,
} from "./ingress-body.ts";
import { keyIdFromToken, tokenFromHeaders } from "./ledger.ts";
import { newRid, observe, trafficKindOf, type Ctx } from "./request-context.ts";
import { deny } from "./wire-deny.ts";
import { runExecute } from "./proxy-execute.ts";
import {
	PREFER_HEADER,
	parsePreferHeader,
} from "../../telemetry/src/prefer-header.ts";
import {
	allowlistedBaggage,
	newTraceparent,
	parseTraceparent,
} from "./trace.ts";
import type { Dialect } from "./upstreams.ts";
import type { AppDeps } from "./app-deps.ts";

export async function proxy(
	req: Request,
	dialect: Dialect,
	path: string,
	deps: AppDeps,
	lane = "",
	pin?: string,
): Promise<Response> {
	const hubId = deps.hubId ?? "local";
	const baggage = allowlistedBaggage(req.headers.get("baggage"));
	const inboundHop = hopFromBaggage(baggage);
	const ctx: Ctx = {
		key: keyIdFromToken(tokenFromHeaders(req.headers)),
		group: "",
		model: "",
		dialect,
		rid: newRid(),
		lane: lane || (inboundHop.peer ? laneFromBaggage(baggage) : ""),
		hintRaw: "",
		hint: null,
		t0: 0,
		tier: "",
		condenseIn: false,
		affKey: null,
		prefixFp: null,
		preference: parsePreferHeader(req.headers.get(PREFER_HEADER)),
		// W461 stage 1: accept a caller traceparent, else root a fresh trace;
		// baggage survives only in the fleet-allowlisted subset. W706: the
		// hop marker rides the same baggage header — origin defaults to self
		// (the request entered the fleet here), peer = the forwarding hub.
		trace: {
			traceparent:
				parseTraceparent(req.headers.get("traceparent")) ?? newTraceparent(),
			baggage,
		},
		hop: {
			origin: inboundHop.origin || hubId,
			peer: inboundHop.peer,
		},
	};
	ctx.trafficKind = trafficKindOf(req);
	ctx.signal = req.signal;
	ctx.t0 = Date.now();
	beginInflight(ctx); // W1259: the exact in-flight index starts here
	const hint = hintFromHeaders(req.headers);
	if (!hint.ok) return deny(deps, ctx, 400, hint.why, "bad_hint", "denied");
	let body: Record<string, unknown>;
	try {
		body = (await readIngressJson(
			req,
			deps.ingressBodyTimeoutMs ?? INGRESS_BODY_TIMEOUT_MS,
			MAX_REQUEST_BODY_BYTES,
		)) as Record<string, unknown>;
	} catch (error) {
		if (error instanceof IngressBodyError) {
			if (error.code === "timeout")
				return deny(
					deps,
					ctx,
					408,
					"request body deadline exceeded",
					"body_timeout",
					"denied",
				);
			if (error.code === "too_large")
				return deny(
					deps,
					ctx,
					413,
					"request body too large",
					"body_too_large",
					"denied",
				);
		}
		return deny(deps, ctx, 400, "invalid JSON body", null, "denied");
	}
	const model = typeof body.model === "string" ? body.model : "";
	if (model.length === 0)
		return deny(deps, ctx, 400, "missing model", null, "denied");
	// W461 stage 2: admitted — unsampled, published before any routing.
	ctx.admitted = true;
	observe(deps, ctx, "lane.request.admitted");
	const wire = await applyWireAids(
		deps,
		req.headers.get("x-belt-aids"),
		body,
		dialect,
		ctx.rid,
	);
	body = wire.body;
	ctx.condenseIn = wire.condenseIn;
	ctx.affKey = deps.affinity ? affKeyOf(body) : null;
	ctx.group = model;
	ctx.model = model;
	ctx.hint = hint.hint;
	ctx.hintRaw = hint.raw;
	ctx.tier = scoreComplexity(textFromMessages(body.messages)).tier;
	// W1265.1 account policy: resolve the verified repo/workspace identity +
	// allowed account tier from the AUTHENTICATED key (the trusted mint name
	// — never the client-supplied claim header, never process/TLS inference)
	// BEFORE any routing. A refusal here is a typed local 4xx, zero outbound.
	const principal = principalOf(req);
	const verdict = applyAccountPolicy(deps.accountPolicy ?? null, {
		kind: principal?.kind ?? null,
		keyName: principal?.name ?? null,
		claimRepo: req.headers.get(REPO_CLAIM_HEADER),
		lane: lane || null,
		pin: pin ?? null,
		group: model,
	});
	if (!verdict.ok) {
		// W1265.2: the refusal still audits the PROVEN binding identity —
		// repo hash + tier + key name land on the decision row.
		if (verdict.audit !== undefined)
			ctx.acct = {
				repoHash: null,
				tier: null,
				keyName: null,
				pin: null,
				allowedHosts: null,
				deniedHosts: null,
				allowedGroups: null,
				claimRepo: null,
				...verdict.audit,
			};
		return deny(deps, ctx, verdict.status, verdict.why, verdict.code, "denied");
	}
	if (verdict.acct !== undefined) ctx.acct = verdict.acct;
	const sel = deps.decide({
		group: model,
		dialect,
		hint: ctx.hint,
		hintRaw: ctx.hintRaw,
		// count_tokens never bridges (openai wire has no count endpoint); a
		// provider-pinned route never bridges either (W1265)
		allowCross: pin === undefined && path !== "/v1/messages/count_tokens",
		providerPin: pin,
	});
	if (!sel.ok) {
		deps.sm
			.counter("buckle_route_decisions_total", "Routing decisions.")
			.inc({ decision: "errored", dialect });
		return deny(
			deps,
			ctx,
			503,
			pin === undefined
				? sel.err.why
				: `provider pin '${pin}' on '${path}': ${sel.err.why}`,
			sel.err.code,
			"errored",
		);
	}
	// W1265.1: confine the walked selection to entitled rows — the router
	// walks sel.ordered, so a scoped list makes cross-boundary fallback
	// structurally impossible (no entitled-set exit crossing the class
	// boundary). Scoped to zero = typed refusal, zero outbound.
	const scoped = scopeSelection(sel.sel, ctx.acct);
	if (!scoped.ok)
		return deny(deps, ctx, scoped.status, scoped.why, scoped.code, "errored");
	ctx.sel = preferAfterScope(scoped.sel, ctx.hint);
	return runExecute(req, ctx, path, body, deps);
}
