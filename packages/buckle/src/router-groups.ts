// src/router-groups.ts — W1299 decomposition of router.ts (behavior identical):
// the group-resolution tier — candidate ordering for a tier (same-dialect
// pass-through first, then bridgeable cross-dialect), benched-leg liveness
// probes, and the remembered rate-limit hold.
import { safeProviderErrorToken } from "../../telemetry/src/http-trace.ts";
import { bridgeRequest } from "./bridge.ts";
import { reportAttempt } from "./router-receipt.ts";
import type {
	RouterHost,
	UpstreamRequest,
	WalkState,
} from "./router-types.ts";
import type { Deployment } from "./upstreams.ts";
	/** Same-dialect deployments first (pass-through precedence); the
	 *  bridgeable other-dialect deployments follow — native translation
	 *  (W426), not opt-in failover. Unbridgeable hops (count_tokens, a
	 *  transform that rejects) are skipped, never attempted. */
export function tierCandidates(host: RouterHost, tier: string, req: UpstreamRequest): Deployment[] {
		const live = host.deps.pool
			.deployments(tier)
			.filter((d) => !host.cooldowns.benched(d));
		// W1124.27: same-dialect is no longer auto-eligible — a chatgpt rung
		// whose body the native bridge refuses is skipped like any
		// unbridgeable hop (skip-not-fail), falling to the next rung verbatim.
		const same = live.filter(
			(d) => d.dialect === req.dialect && bridgeRequest(req, d) !== null,
		);
		const cross = live.filter(
			(d) => d.dialect !== req.dialect && bridgeRequest(req, d) !== null,
		);
		return [...same, ...cross];
	}
	/** W1077: one cheap liveness probe against a benched leg. Any HTTP
	 *  response (even 401/404 - the leg ANSWERS) proves liveness: clear the
	 *  bench and hand the leg back for the walk. null = nothing probeable
	 *  or the probe got no answer. */
export async function probeBenchedLeg(
	host: RouterHost,
		tier: string,
		req: UpstreamRequest,
		st: WalkState,
		dep?: Deployment,
	): Promise<Deployment | null> {
		const remainingMs = st.deadlineMs - host.now();
		if (remainingMs <= 0 || req.signal?.aborted) return null;
		const target =
			dep ??
			host.deps.pool
				.deployments(tier)
				.find(
					(d) => host.cooldowns.benched(d) && bridgeRequest(req, d) !== null,
				);
		if (target === undefined || !host.cooldowns.benched(target)) return null;
		const timeout = AbortSignal.timeout(Math.min(remainingMs, 3_000));
		const signal = req.signal
			? AbortSignal.any([req.signal, timeout])
			: timeout;
		const resp =
			(await host.deps.probe?.(target, signal)) ??
			(await fetch(`${target.url}/v1/models`, {
				method: "GET",
				signal,
			}).catch(() => null));
		if (resp === null) return null;
		host.cooldowns.success(target);
		return target;
	}
	/** A temporarily ejected rate-limited tier still has an actionable
	 * outcome: a typed LOCAL hold — never a fabricated provider 429 (W1257).
	 * The provider's own last-seen refusal words ride as attributed context;
	 * a real upstream rung later in the walk still outranks the memory. */
export function rememberCooledRateLimit(
	host: RouterHost,
		tier: string,
		req: UpstreamRequest,
		st: WalkState,
	): void {
		const legs = host.deps.pool
			.deployments(tier)
			.filter((dep) => bridgeRequest(req, dep) !== null)
			.map((dep) => ({
				dep,
				seconds: host.cooldowns.rateLimitRemainingS(dep),
				detail: host.cooldowns.rateLimitDetail(dep),
			}))
			.filter((leg) => leg.seconds !== null);
		if (legs.length === 0) return;
		const soonest = legs.reduce((a, b) =>
			(a.seconds ?? 0) <= (b.seconds ?? 0) ? a : b,
		);
		const d = soonest.detail;
		const words = d
			? `; last provider refusal: code ${String(d.code ?? "unknown")} ${d.type ?? "type unknown"} "${d.message.slice(0, 240)}"`
			: "";
		st.status = 503;
		st.error = `provider ${tier} rate-limit cooldown — answered from gateway cooldown, not the provider (${String(soonest.seconds)}s left; W1257)${words}`;
		st.lastFailure = {
			source: "local-admission",
			status: 503,
			kind: "local_admission",
			retryAfterS: soonest.seconds,
		};
		// one local-admission attempt receipt with the banked provider tokens,
		// so the trace tells the truth about where this answer came from
		reportAttempt(host, 
			req,
			soonest.dep,
			st.attempts,
			host.now(),
			503,
			"rate_limited",
			soonest.seconds,
			undefined,
			undefined,
			null,
			"local-admission",
			{
				providerPool: null,
				queueWaitMs: null,
				providerErrorCode: safeProviderErrorToken(d?.code ?? null),
				providerErrorType: safeProviderErrorToken(d?.type ?? null),
			},
		);
	}
