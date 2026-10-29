// src/router-walk.ts — W1299 decomposition of router.ts (behavior identical):
// the ladder-walk tier — deadline/expiry, bounded retry waits, the
// same-tier retry loop (attemptTier), the plain and W140 selected walks,
// the gated ladder, and the exhausted() terminal.
import { safeCorrelationId } from "@klh/telemetry/src/http-trace.ts";
import { TransportObservation } from "@klh/telemetry/src/transport-evidence.ts";
import { bridgeRequest } from "./bridge.ts";
import { type CandidateRow, candIdOf } from "./candidates.ts";
import { mayEscalate, type RouteSelection } from "./decide.ts";
import { FLASHX } from "./policy.ts";
import { providerPoolIdOf, tryOnce } from "./router-attempt.ts";
import {
	probeBenchedLeg,
	rememberCooledRateLimit,
	tierCandidates,
} from "./router-groups.ts";
import { reportAttempt } from "./router-receipt.ts";
import type {
	ExecuteResult,
	RouterHost,
	TryOutcome,
	UpstreamRequest,
	WalkState,
} from "./router-types.ts";
import { UpstreamError } from "./router-types.ts";
import type { Deployment } from "./upstreams.ts";
/** Same-tier failover (fail fast — owner correction 2026-10-29): each
 *  candidate is tried at most ONCE, in order, with NO in-gateway sleep.
 *  num_retries bounds the heal-able hops inside the tier; the resilience
 *  max_failover_hops + failover budget bound hops across the whole walk
 *  after an upstream HTTP refusal. The outermost client owns the one retry
 *  layer (honest 429/503 + Retry-After). */
export async function attemptTier(
	host: RouterHost,
	req: UpstreamRequest,
	tier: string,
	candidates: Deployment[],
	st: WalkState,
): Promise<ExecuteResult | null> {
	const retries = host.policy.num_retries ?? 1;
	const floorCapS = host.policy.retry_after_cap_s ?? 60;
	const perAttemptMs = (host.policy.request_timeout_s ?? 120) * 1000;
	// W450: streaming bodies get idle+total guards; non-streaming keeps
	// request_timeout_s as its whole-exchange cap (the wire applies it).
	const stream =
		req.body.stream === true
			? {
					idleMs: (host.policy.stream_idle_timeout_s ?? 60) * 1000,
					totalMs: (host.policy.stream_total_timeout_s ?? 900) * 1000,
				}
			: undefined;
	// W987: skip-grade rung failures (auth, client-fault, local admission)
	// advance to the next candidate free; only heal-able failures (5xx/
	// timeouts/rate limits) spend the num_retries hop allowance.
	let healHops = 0;
	let cursor = 0;
	const timedOutOrigins = new Set<string>();
	while (cursor < candidates.length) {
		if (req.signal?.aborted) return halt(st.attempts);
		if (walkExpired(host, st)) break;
		const nextIndex = candidates.findIndex(
			(candidate, index) =>
				index >= cursor &&
				!timedOutOrigins.has(new URL(candidate.url).origin) &&
				!st.unavailablePools?.has(providerPoolIdOf(candidate) ?? ""),
		);
		const dep = nextIndex < 0 ? undefined : candidates[nextIndex];
		if (!dep) break;
		cursor = nextIndex + 1;
		// One retry layer: after an upstream HTTP refusal, at most
		// max_failover_hops immediate hops (budgeted fleet-wide).
		if (!mayFailover(host, req, st)) break;
		const timeoutMs = Math.max(
			1,
			Math.min(perAttemptMs, st.deadlineMs - host.now()),
		);
		// W2192 (W1096 re-land): the reachability probe bound (policy
		// connect_timeout_s, clamped to the walk remainder) — a dead origin
		// resolves within this window as a connect-layer failure, never at
		// the model first-byte deadline.
		const connectMs = Math.max(
			1,
			Math.min(
				(host.policy.connect_timeout_s ?? 5) * 1000,
				st.deadlineMs - host.now(),
			),
		);
		st.attempts++;
		const startedAt = host.now();
		const observedReq = { ...req, transport: new TransportObservation() };
		let r: TryOutcome;
		try {
			r = await tryOnce(
				host,
				observedReq,
				dep,
				timeoutMs,
				stream,
				st.deadlineMs - startedAt,
				connectMs,
			);
		} catch (error) {
			if (req.signal?.aborted) {
				// W1124.42: the final receipt must truthfully retain the
				// attempt — a wire guard that fired (or a classified upstream
				// refusal racing the hangup) keeps its network attribution;
				// a plain hangup with no upstream boundary stays plain.
				const upstream = error instanceof UpstreamError ? error : null;
				const timedOutPhase =
					observedReq.transport?.snapshot()?.timeoutPhase ?? null;
				reportAttempt(
					host,
					observedReq,
					dep,
					st.attempts,
					startedAt,
					null,
					"downstream_cancel",
					null,
					undefined,
					undefined,
					null,
					upstream !== null || timedOutPhase !== null ? "network" : null,
					upstream ?? undefined,
				);
				return halt(st.attempts);
			}
			if (!(error instanceof UpstreamError)) throw error;
			if (error.timedOut) {
				timedOutOrigins.add(new URL(dep.url).origin);
				if (error.providerPool !== null && (error.queueWaitMs ?? 0) > 0) {
					st.unavailablePools ??= new Set();
					st.unavailablePools.add(error.providerPool);
				}
			}
			reportAttempt(
				host,
				observedReq,
				dep,
				st.attempts,
				startedAt,
				null,
				error.layer === "connect" ? "connect_unreachable" : "network",
				error.layer === "connect" ? host.cooldowns.remainingS(dep) : null,
				undefined,
				undefined,
				null,
				"network",
				error,
			);
			// W985 skip-not-fail: an unreachable rung (ECONNREFUSED, timeout)
			// must not kill the ladder — record it and walk on to the next
			// candidate / fallback rung. A banked provider rate limit still
			// outranks the dead hop: end the tier, its 429 answers at
			// exhausted() verbatim.
			if (st.rateLimit) break;
			st.status = error.status;
			st.error = `no healthy upstream for ${req.group} (${error.message})`;
			st.peerTrace = null;
			st.lastFailure = {
				source: "network",
				status: error.status,
				kind: "network",
				transportTimeoutPhase:
					observedReq.transport.snapshot()?.timeoutPhase ?? null,
			};
			// A failed network exchange already spent this row's entire
			// request timeout. Repeating the same last row cannot improve
			// this walk; hand the remaining time to the next policy tier.
			if (nextIndex >= candidates.length - 1) break;
			continue;
		}
		if (r.ok) {
			const upstreamId = safeCorrelationId(
				r.response.headers.get("x-request-id") ??
					r.response.headers.get("x-klh-upstream-request-id"),
			);
			const callId = safeCorrelationId(
				r.response.headers.get("x-litellm-call-id"),
			);
			reportAttempt(
				host,
				observedReq,
				dep,
				st.attempts,
				startedAt,
				r.response.status,
				null,
				null,
				upstreamId,
				callId,
				null,
				null,
				r,
			);
			return {
				kind: "upstream",
				response: r.response,
				deployment: dep,
				candidateId: candIdOf(dep),
				tier,
				attempts: st.attempts,
				stream: req.body.stream === true,
			};
		}
		if ("localAdmission" in r) {
			const account = providerPoolIdOf(dep);
			if (account !== null) {
				st.unavailablePools ??= new Set();
				st.unavailablePools.add(account);
			}
			reportAttempt(
				host,
				observedReq,
				dep,
				st.attempts,
				startedAt,
				r.status,
				"local_admission",
				r.retryAfterS,
				undefined,
				undefined,
				null,
				"local-admission",
				r,
			);
			// W1078 skip-grade: the local account pool is shared across the
			// tier's rows, so repeating a refused row inside this tier cannot
			// heal — advance to the next candidate / fallback rung FREE (no
			// bench, no cooldown metric, no retry budget, no rate-limit
			// memory). The refusal becomes the walk's lastFailure, so an
			// exhausted ladder answers 503 + window-derived Retry-After.
			st.status = r.status;
			st.error = r.error;
			st.peerTrace = null;
			st.lastFailure = {
				source: "local-admission",
				status: r.status,
				kind: "local_admission",
				retryAfterS: r.retryAfterS,
			};
			continue;
		}
		reportAttempt(
			host,
			observedReq,
			dep,
			st.attempts,
			startedAt,
			r.status,
			r.kind,
			r.retryAfterS,
			r.requestId,
			r.callId,
			r.upstreamRefusalCode ?? null,
			r.refusalSource,
			r,
		);
		st.status = r.status;
		st.error = r.error;
		st.peerTrace = r.peerTrace;
		st.lastFailure = {
			source: r.refusalSource,
			status: r.status,
			kind: r.kind,
			transportTimeoutPhase: r.transportTimeoutPhase,
			requestId: r.requestId,
			callId: r.callId,
			upstreamRefusalCode: r.upstreamRefusalCode ?? null,
			retryAfterS:
				r.retryAfterS === null
					? undefined
					: Math.max(
							1,
							Math.min(Math.ceil(r.retryAfterS), Math.max(1, floorCapS)),
						),
		};
		// An upstream HTTP refusal arms the one-retry-layer cap (mayFailover).
		st.httpRefusals = (st.httpRefusals ?? 0) + 1;
		if (walkExpired(host, st)) break;
		if (r.kind === "network" || r.kind === "timeout") {
			// A peer transport failure has the same walk semantics as a
			// local fetch timeout. Do not queue its account again after
			// already spending admission dwell; independent tiers need
			// the remainder of the original first-byte budget.
			timedOutOrigins.add(new URL(dep.url).origin);
			const account = providerPoolIdOf(dep);
			if (account !== null && (r.queueWaitMs ?? 0) > 0) {
				st.unavailablePools ??= new Set();
				st.unavailablePools.add(account);
			}
			continue;
		}
		if (r.kind === "rate_limited") {
			if (!st.rateLimit)
				st.rateLimit = { response: r.response, tier, source: "upstream" };
			// A refusal applies to every alias of the account: skip it within
			// this walk (the shared cold mark holds it for later requests).
			const account = providerPoolIdOf(dep);
			if (account !== null) {
				st.unavailablePools ??= new Set();
				st.unavailablePools.add(account);
			}
		}
		if (r.contextWindow) st.ctxWindow = r.response;
		if (r.exhaustTier) {
			if (r.hopRefusal) st.hopRefusal = r.hopRefusal;
			break;
		}
		// W987: an auth/client-fault rung failed on THIS deployment (its
		// credential or its model) — the bench already happened in
		// tryOnce; advance to the next candidate free.
		if (r.clientFault || r.kind === "auth") continue;
		// Heal-able failure: an immediate hop to the NEXT candidate (never a
		// same-candidate replay, never a sleep), bounded by num_retries.
		healHops++;
		if (healHops > retries) break;
	}
	return null;
}
/** May the walk take another upstream attempt? Free until the first
 *  upstream HTTP refusal; after it, at most max_failover_hops immediate
 *  hops, each spending the per-group failover budget. A refused hop caps
 *  the walk (st.capped) — the client gets the honest refusal now. */
function mayFailover(
	host: RouterHost,
	req: UpstreamRequest,
	st: WalkState,
): boolean {
	const refusals = st.httpRefusals ?? 0;
	if (refusals === 0) {
		host.failover?.record(req.group, false);
		return true;
	}
	const cfg = host.policy.resilience;
	const hops = cfg?.max_failover_hops ?? 1;
	if (refusals > hops || (host.failover && !host.failover.canRetry(req.group))) {
		st.capped = true;
		return false;
	}
	host.failover?.record(req.group, true);
	return true;
}
function walkExpired(host: RouterHost, st: WalkState): boolean {
	if (host.now() < st.deadlineMs) return false;
	st.status = 504;
	st.error = "Buckle first-byte walk deadline exceeded";
	st.peerTrace = null;
	st.lastFailure = { source: "network", status: 504, kind: "walk_deadline" };
	return true;
}
/** Ladder walk: requested group first, then the policy fallback list.
 *  flashx tiers are refused (owner directive); dormant groups (zero
 *  matching deployments — e.g. cloud tiers with no BUCKLE_UPSTREAMS
 *  override) are skipped as skip-not-failure. */
export async function executeWalk(
	host: RouterHost,
	req: UpstreamRequest,
): Promise<ExecuteResult> {
	if (req.signal?.aborted) return halt(0);
	// W1118.1: an admitted hop contract CLAMPS the local walk deadline —
	// an absolute deadline never extends the local budget, only tightens.
	const deadlineMs = Math.min(
		host.now() + (host.policy.first_byte_budget_s ?? 240) * 1000,
		req.hopContract?.deadlineMs ?? Number.POSITIVE_INFINITY,
	);
	if (req.sel)
		return walkSelected(host, req, {
			attempts: 0,
			status: 502,
			error: `no healthy upstream for ${req.group}`,
			deadlineMs,
		});
	const st: WalkState = {
		attempts: 0,
		status: 502,
		error: `no healthy upstream for ${req.group}`,
		deadlineMs,
	};
	const tiers = [req.group, ...(host.policy.fallbacks?.[req.group] ?? [])];
	for (const tier of tiers) {
		if (walkExpired(host, st)) break;
		// W1118.1: a peer's hop refusal ends the whole walk — the contract
		// binds every fleet leg, a fallback rung must not serve what the
		// refusing rung's verdict condemned.
		if (st.hopRefusal || st.capped) break;
		if (FLASHX.test(tier)) {
			host.metrics?.refused(tier);
			continue;
		}
		const candidates = tierCandidates(host, tier, req);
		if (candidates.length === 0) {
			// W1077: probe-before-fail - a benched wall must not outlive the
			// upstream. Probe one benched leg; a live leg clears its bench
			// and rejoins this tier walk instead of stranding the request.
			const probed = await probeBenchedLeg(host, tier, req, st);
			if (probed !== null) {
				const r = await attemptTier(host, req, tier, [probed], st);
				if (r !== null) return r;
				continue;
			}
			rememberCooledRateLimit(host, tier, req, st);
			continue;
		}
		if (tier !== req.group) host.metrics?.fallback(tier);
		const r = await attemptTier(host, req, tier, candidates, st);
		if (r !== null) return r;
	}
	walkExpired(host, st);
	return exhausted(st);
}
/** W140 selection walk: deliver the selected candidate first, then the
 *  policy ladder as the failure domain. must (full fit) keeps its domain
 *  closed — ladder rungs would substitute beyond the hint (law 2). */
async function walkSelected(
	host: RouterHost,
	req: UpstreamRequest,
	st: WalkState,
): Promise<ExecuteResult> {
	const sel = req.sel;
	if (!sel) return exhausted(st); // unreachable (guarded)
	const tried = new Set<string>();
	// Unbridgeable rows (count_tokens on an openai row, a transform that
	// rejects) are skipped, never attempted — skip-not-fail.
	const ordered = sel.ordered.filter(
		(row) => bridgeRequest(req, row.dep) !== null,
	);
	// W1080: name the real refusal — an all-unbridgeable selection is a
	// body the transform rejected, not an unhealthy upstream.
	if (ordered.length === 0 && sel.ordered.length > 0) {
		st.error = `all ${String(sel.ordered.length)} selected row(s) unbridgeable — the transform rejected this request body`;
		st.peerTrace = null;
	}
	// The escalation law owns EVERY prefer/no-hint cloud delivery: the
	// hint ranks the head, it does not authorize leaving the machine
	// (W136 §5.2 — prefs AND tier-warrant AND failed-twice, all AND-ed).
	// Only must's demanded set bypasses the ESCALATION legs (tier-warrant
	// and failed-twice — the demand is the warrant, W209); the owner
	// prefs still bind it (precedence 1, W709/W694 H3: prefs > hint >
	// tier). An empty-demand must (total=0) is not a demanded set and
	// does not ride the exemption either.
	const demanded = sel.verb === "must" && sel.total > 0;
	const prefsOpen = sel.prefs.allow_cloud && sel.prefs.cost_speed !== "cost";
	const gate = (row: CandidateRow): boolean =>
		row.kind === "cloud" &&
		(demanded
			? !prefsOpen
			: row.group === req.group && prefsOpen
				? false // an explicit model pin is the cloud warrant
				: !mayEscalate({
						group: row.group,
						tier: req.tier,
						attempts: st.attempts,
						prefs: sel.prefs,
						cloudGroups: sel.cloudGroups,
					}));
	for (const row of ordered) {
		if (req.signal?.aborted) return halt(st.attempts);
		if (walkExpired(host, st)) break;
		// W1118.1: a peer hop-contract refusal ends the selected walk too.
		if (st.hopRefusal || st.capped) break;
		if (gate(row)) continue;
		if (host.cooldowns.rateLimitRemainingS(row.dep) !== null) {
			// W1077: probe-before-skip in the PRODUCTION selected path - a
			// rate-limit bench must not outlive the upstream. A live probe
			// clears the bench and the row rides now; a dead probe keeps the
			// remembered 429 envelope for the exhausted relay.
			if ((await probeBenchedLeg(host, row.group, req, st, row.dep)) !== null) {
				tried.add(row.candidate_id);
				const r = await attemptTier(host, req, row.group, [row.dep], st);
				if (r !== null) return r;
				continue;
			}
			rememberCooledRateLimit(host, row.group, req, st);
			continue;
		}
		tried.add(row.candidate_id);
		const r = await attemptTier(host, req, row.group, [row.dep], st);
		if (r !== null) return r;
	}
	if (sel.verb === "must" && sel.fit === sel.total && sel.total > 0) {
		// must-domain closed: no substitution beyond the hint (law 2)
		walkExpired(host, st);
		return exhausted(st);
	}
	return gatedLadder(host, req, sel, st, tried);
}
/** Ladder rungs after selection: flashx refused, cloud rungs fire only
 *  under the W136 escalation law (allow_cloud, not cost mode, tier
 *  warrants or quality, local failed twice). */
async function gatedLadder(
	host: RouterHost,
	req: UpstreamRequest,
	sel: RouteSelection,
	st: WalkState,
	tried: Set<string>,
): Promise<ExecuteResult> {
	const tiers = [req.group, ...(host.policy.fallbacks?.[req.group] ?? [])];
	for (const tier of tiers) {
		if (walkExpired(host, st)) break;
		// W1118.1: a peer's hop refusal ends the whole walk — the contract
		// binds every fleet leg, a fallback rung must not serve what the
		// refusing rung's verdict condemned.
		if (st.hopRefusal || st.capped) break;
		if (FLASHX.test(tier)) {
			host.metrics?.refused(tier);
			continue;
		}
		if (
			sel.cloudGroups.has(tier) &&
			!mayEscalate({
				group: tier,
				tier: req.tier,
				attempts: st.attempts,
				prefs: sel.prefs,
				cloudGroups: sel.cloudGroups,
			})
		)
			continue; // gate closed: SIMPLE/MEDIUM never leave the machine
		// W1265.1 account boundary: when the selection carries the mark, the
		// ladder's rungs are confined to the entitled domain — a tier with no
		// entitled candidate is skipped, never substituted across the class
		// boundary (the cross-boundary e2e proves zero foreign outbound).
		const entitled =
			sel.accountScoped === true
				? new Set(sel.ordered.map((r) => r.candidate_id))
				: null;
		const candidates = tierCandidates(host, tier, req).filter(
			(d) =>
				!tried.has(candIdOf(d)) &&
				(entitled === null || entitled.has(candIdOf(d))),
		);
		if (candidates.length === 0) {
			rememberCooledRateLimit(host, tier, req, st);
			continue;
		}
		if (tier !== req.group) host.metrics?.fallback(tier);
		const r = await attemptTier(host, req, tier, candidates, st);
		if (r !== null) return r;
	}
	walkExpired(host, st);
	return exhausted(st);
}
/** End of a walk with nothing delivered: an all-rungs context-window
 *  overflow answers the upstream's 4xx; anything else is exhausted. */
const halt = (n: number): ExecuteResult => ({ kind: "aborted", attempts: n });
function exhausted(st: WalkState): ExecuteResult {
	if (st.rateLimit)
		return {
			kind: "client-error",
			response: st.rateLimit.response,
			tier: st.rateLimit.tier,
			attempts: st.attempts,
			refusalSource: st.rateLimit.source,
			failureKind: "rate_limited",
		};
	if (st.ctxWindow)
		return {
			kind: "client-error",
			response: st.ctxWindow,
			tier: "",
			attempts: st.attempts,
			refusalSource: "upstream",
			failureKind: "bad_request",
		};
	// Shared cold mark: the instant local 429 (no upstream knocked) outranks
	// a generic exhausted 502 — it carries the honest Retry-After.
	if (st.coldHold)
		return {
			kind: "exhausted",
			status: 429,
			error: st.coldHold.error,
			peerTrace: null,
			attempts: st.attempts,
			lastFailure: {
				source: "local-admission",
				status: 429,
				kind: "rate_limited",
				retryAfterS: st.coldHold.retryAfterS,
			},
			retryAfterS: st.coldHold.retryAfterS,
			quota: st.coldHold.quota,
		};
	return {
		kind: "exhausted",
		status: st.status,
		error: st.error,
		peerTrace: st.peerTrace,
		attempts: st.attempts,
		lastFailure: st.lastFailure,
		...(st.lastFailure?.status === 503 &&
		st.lastFailure.retryAfterS !== undefined
			? { retryAfterS: st.lastFailure.retryAfterS }
			: {}),
	};
}
