// src/proxy-ingress.ts — the proxy ingress: request context, body read,
// wire aids, account-policy verdict, routing decision + entitlement scope.

import { rungIdOf } from "@klh/telemetry/src/hop-contract.ts";
import {
	PREFER_HEADER,
	parsePreferHeader,
} from "@klh/telemetry/src/prefer-header.ts";
import { z } from "zod";
import {
	applyAccountPolicy,
	preferAfterScope,
	REPO_CLAIM_HEADER,
	scopeSelection,
} from "./account-policy.ts";
import { resolveAdapter } from "./adapters/index.ts";
import { affKeyOf } from "./affinity.ts";
import { applyWireAids } from "./aids-routes.ts";
import type { AppDeps } from "./app-deps.ts";
import { scoreComplexity, textFromMessages } from "./complexity.ts";
import { CountTokensBodySchema, estimatedCountTokens } from "./count-tokens.ts";
import { principalOf } from "./gov/federation.ts";
import { beginInflight } from "./gov/inflight.ts";
import { hintFromHeaders } from "./hints.ts";
import { hopFromBaggage, laneFromBaggage } from "./hop.ts";
import { admitHopContract, HOP_CONTRACT_HEADER } from "./hop-deadline.ts";
import {
	INGRESS_BODY_TIMEOUT_MS,
	IngressBodyError,
	MAX_REQUEST_BODY_BYTES,
	readIngressJson,
} from "./ingress-body.ts";
import { keyIdFromToken, tokenFromHeaders } from "./ledger.ts";
import { runExecute } from "./proxy-execute.ts";
import {
	type Ctx,
	newRid,
	observe,
	safeAuditPath,
	safeAuditToken,
	trafficKindOf,
} from "./request-context.ts";
import {
	allowlistedBaggage,
	newTraceparent,
	parseTraceparent,
} from "./trace.ts";
import type { Dialect } from "./upstreams.ts";
import { deny } from "./wire-deny.ts";

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
		trafficKind: trafficKindOf(req),
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
	ctx.signal = req.signal;
	ctx.t0 = Date.now();
	// W2256: capture the audit provenance BEFORE any denial can fire — every
	// refused request still names what it asked for and how it arrived.
	ctx.auditPath = safeAuditPath(path);
	ctx.auditAllowCross = null; // decided later at the decide seam
	ctx.auditProviderPin = safeAuditToken(pin);
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
	if (path === "/v1/messages/count_tokens") {
		const countBody = CountTokensBodySchema.safeParse(body);
		if (!countBody.success)
			return deny(
				deps,
				ctx,
				400,
				z.prettifyError(countBody.error),
				"invalid_count_tokens_body",
				"denied",
			);
		body = countBody.data;
	}
	const model = typeof body.model === "string" ? body.model : "";
	if (model.length === 0)
		return deny(deps, ctx, 400, "missing model", null, "denied");
	// W1118.1: admit the arriving hop contract — expired/malformed/empty-
	// budget/repeated-rung refuse as typed traced failures — or root one
	// for a fresh fleet entry. ownRung derives from the URL the caller
	// addressed this hop by + the wire model (the candIdOf recipe), so a
	// retry stays the same rung and an immediate cycle repeats its rung.
	const selfUrl = new URL(req.url);
	const ownRung = rungIdOf(
		selfUrl.hostname,
		Number(selfUrl.port) || (selfUrl.protocol === "https:" ? 443 : 80),
		model,
	);
	const rawContract = req.headers.get(HOP_CONTRACT_HEADER);
	const admitted = admitHopContract(rawContract, Date.now(), ownRung);
	if (!admitted.ok)
		return deny(
			deps,
			ctx,
			admitted.denial.status,
			admitted.denial.why,
			admitted.denial.code,
			"denied",
		);
	const contract = admitted.contract ?? deps.router.hopContractRoot(Date.now());
	ctx.hopContract = { ...contract, ownRung };
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
	const matchingGroup = deps.pool
		.deployments(model)
		.filter((dep) => pin === undefined || dep.adapter === pin);
	const estimateCount =
		path === "/v1/messages/count_tokens" &&
		matchingGroup.length > 0 &&
		!matchingGroup.some(
			(dep) =>
				dep.dialect === "anthropic" && resolveAdapter(dep).caps.countTokens,
		);
	const sel = deps.decide({
		group: model,
		dialect,
		hint: ctx.hint,
		hintRaw: ctx.hintRaw,
		// count_tokens never bridges (openai wire has no count endpoint); a
		// provider-pinned route never bridges either (W1265)
		allowCross:
			estimateCount ||
			(pin === undefined && path !== "/v1/messages/count_tokens"),
		providerPin: pin,
	});
	// W2256: the decided bridging posture rides ctx — denials below this seam
	// audit it (a selection-shaped refusal keeps the requested context).
	ctx.auditAllowCross =
		estimateCount ||
		(pin === undefined && path !== "/v1/messages/count_tokens");
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
		return deny(
			deps,
			ctx,
			scoped.status,
			scoped.why,
			scoped.code,
			"errored",
			sel.sel.head.dep.provider,
		);
	ctx.sel = preferAfterScope(scoped.sel, ctx.hint);
	// W2257.1: an estimate is entitlement-bound — the scoped domain must
	// still hold a row for the EXACT requested group. A policy-fallback head
	// is entitled delivery for another group, never an estimate for this
	// one; scoped-to-zero for the requested group refuses typed, zero outbound.
	if (estimateCount && !ctx.sel.ordered.some((row) => row.group === ctx.group))
		return deny(
			deps,
			ctx,
			503,
			`no entitled upstream for '${ctx.group}' within the account boundary — count estimate refused, zero outbound`,
			"buckle.tier_no_upstream",
			"errored",
		);
	if (estimateCount) return estimatedCountTokens(deps, ctx, body);
	return runExecute(req, ctx, path, body, deps);
}
