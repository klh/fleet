// src/router-types.ts — W1299 decomposition of router.ts (behavior identical):
// router contracts — public request/result types, walk state, the
// UpstreamError marker, and the RouterHost seam the purpose modules are
// written against.
import type { HopReceipt } from "@klh/telemetry/src/http-trace.ts";
import type {
	TransportEvidence,
	TransportObservation,
} from "@klh/telemetry/src/transport-evidence.ts";
import type { ErrorKind } from "./adapters/errors.ts";
import type { Cooldowns } from "./cooldown.ts";
import type { RouteSelection } from "./decide.ts";
import type { HopContract } from "./hop-deadline.ts";
import type { GatewayPolicy } from "./policy.ts";
import type { ProviderAdmissionCore } from "./provider-admission-core.ts";
import type { RetryBudget } from "./resilience.ts";
import type { ResilienceConfig } from "./resilience-config.ts";
import type { TraceContext } from "./trace.ts";
import type { Deployment, Dialect, UpstreamPool } from "./upstreams.ts";
export type ExecuteResult =
	| {
			kind: "upstream";
			response: Response;
			deployment: Deployment;
			candidateId: string; // delivered candidate (W136 audit join)
			tier: string;
			attempts: number;
			stream: boolean;
	  }
	| {
			kind: "client-error";
			response: Response;
			tier: string;
			attempts: number;
			refusalSource: "upstream" | "cooldown";
			failureKind: ErrorKind;
			/** Configured provider of the leg that produced this refusal. */
			provider?: string;
			/** Evidence level for that provider identity (owner law 2026-10-29):
			 *  provider_response = the provider's own endpoint answered;
			 *  litellm_translation = the status came from a litellm
			 *  translation layer, the provider rides configuration only. */
			providerSource?: "provider_response" | "litellm_translation";
	  }
	| {
			kind: "aborted";
			attempts: number; // W1124.42.1: real count at the hangup
	  }
	| {
			kind: "exhausted";
			status: number;
			error: string;
			attempts: number;
			lastFailure?: FailureProvenance;
			/** Bounded, validated downstream Buckle error chain. */
			peerTrace?: string | null;
			retryAfterS?: number;
			/** A quota-wall cold hold: the client must not retry into it. */
			quota?: boolean;
	  };

interface FailureProvenance {
	source: "upstream" | "bridged-upstream" | "network" | "local-admission";
	/** Configured provider of the failing leg (config identity, never
	 *  inferred from error text). */
	provider?: string;
	/** provider_response = the provider's own endpoint answered;
	 *  litellm_translation = the status came from a litellm layer. */
	providerSource?: "provider_response" | "litellm_translation";
	status: number;
	kind: string;
	requestId?: string;
	callId?: string;
	retryAfterS?: number;
	upstreamRefusalCode?: string | null;
	transportTimeoutPhase?: TransportEvidence["timeoutPhase"];
}
export interface UpstreamRequest {
	group: string;
	dialect: Dialect;
	path: string;
	body: Record<string, unknown>;
	key: string;
	/** The Buckle audit join key; no credential or request body rides telemetry. */
	rid?: string;
	/** W461 stage 1: request-scoped W3C trace context (correlation only —
	 *  never identity/authz). Absent → the wire roots a fresh trace. */
	trace?: TraceContext;
	/** W706: the outbound baggage for a relay leg to a buckle-marked peer
	 *  (origin passed through + peer=self). Absent/non-buckle → the strip. */
	relayBaggage?: string;
	/** W1118.1: the admitted (or rooted) hop contract — its absolute
	 *  deadline clamps the walk; its child form rides every fleet leg.
	 *  Absent on direct internal callers (no contract, no clamp). */
	hopContract?: HopContract;
	/** W1118.1: this hop's own rung id (ingress URL + wire model) — the
	 *  sender-side append for the child contract. */
	ownRung?: string;
	/** Canonicalized .prefer selection, diagnostic only. */
	preference?: string | null;
	signal?: AbortSignal;
	/** Internal, attempt-local observer; never constructed from client headers/body. */
	transport?: TransportObservation;
	// W140 routing laws: the pure decision result (handlers decided via the
	// candidate table before dispatch) + the complexity tier + the raw hint,
	// threaded for the escalation gate and audit echo.
	sel?: RouteSelection;
	tier?: string;
	hintRaw?: string;
}
export interface RouterMetrics {
	fallback(tier: string): void;
	cooldown(dep: string): void;
	refused(tier: string): void;
	/** Every attempted rung, including network failures and later fallbacks. */
	attempt?(receipt: HopReceipt): void;
}
/** A single upstream attempt's classified outcome. */
export type TryOutcome = {
	transportTimeoutPhase?: TransportEvidence["timeoutPhase"];
	providerPool?: string | null;
	queueWaitMs?: number | null;
	providerErrorCode?: string | null;
	providerErrorType?: string | null;
} & (
	| { ok: true; response: Response }
	| {
			ok: false;
			/** W1078 local admission refusal: the bounded account-pool queue
			 *  refused (full or wait expired) BEFORE any upstream attempt —
			 *  no fetch happened, nothing benched, no provider cooldown. */
			localAdmission: true;
			status: 503;
			error: string;
			/** Window-derived floor from the pool policy — config, never a
			 *  fabricated provider verdict. */
			retryAfterS: number;
	  }
	| {
			ok: false;
			response: Response;
			status: number;
			error: string;
			retryAfterS: number | null;
			clientFault: boolean;
			exhaustTier: boolean;
			refusalSource: "upstream" | "bridged-upstream";
			requestId?: string;
			callId?: string;
			peerTrace?: string | null;
			upstreamRefusalCode?: string | null;
			/** W1118.1: set when this failure IS a peer's typed hop-contract
			 *  refusal (x-belt-error hop_contract_*) — always rides exhaustTier
			 *  so the tier cannot retry the refusing leg either. */
			hopRefusal?: string | null;
			/** W134 §1 normalized kind (adapters/errors.ts) */
			kind: ErrorKind;
			/** bad_request subclass: the prompt overflowed this deployment's
			 *  window — fail over (a bigger window may fit), never bench */
			contextWindow: boolean;
	  }
);
/** Walk state threaded through the ladder. ctxWindow keeps the last
 *  context-window rejection: if every rung overflows, the client gets that
 *  upstream 4xx (actionable) instead of a generic 502. */
export interface WalkState {
	attempts: number;
	status: number;
	error: string;
	peerTrace?: string | null;
	deadlineMs: number;
	/** Account Retry-After or admission timeout cannot heal through an alias. */
	unavailablePools?: Set<string>;
	ctxWindow?: Response;
	rateLimit?: {
		response: Response;
		tier: string;
		source: "upstream" | "cooldown";
		/** Configured provider of the rate-limited leg. */
		provider?: string;
		/** provider_response | litellm_translation (see FailureProvenance). */
		providerSource?: "provider_response" | "litellm_translation";
	};
	lastFailure?: FailureProvenance;
	/** W1118.1: a peer's hop-contract refusal is a chain verdict — once set,
	 *  the remaining walk (selected rows, gated ladder, tier fallbacks)
	 *  stops instead of detouring around the refusing rung. */
	hopRefusal?: string | null;
	/** Upstream HTTP refusals seen this walk — arms the one-retry-layer
	 *  failover cap (resilience.max_failover_hops). */
	httpRefusals?: number;
	/** The hop cap or failover budget refused another attempt: the walk
	 *  stops and answers the honest refusal now. */
	capped?: boolean;
	/** Every candidate of a tier sat behind the shared cold mark: the local
	 *  instant answer (429 + Retry-After; quota walls say x-should-retry:
	 *  false) — no upstream was knocked. */
	coldHold?: { retryAfterS: number; quota: boolean; error: string };
}
/** Thrown when an upstream is unreachable (network/timeout); the walk
 *  catches it and keeps going (ladder), rethrows on caller abort. */
export class UpstreamError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly layer: "connect" | "upstream" = "upstream",
		public readonly timedOut = false,
		public readonly providerPool: string | null = null,
		public readonly queueWaitMs: number | null = null,
	) {
		super(message);
	}
}
export interface RouterDeps {
	pool: UpstreamPool;
	// shared ejection state — the candidate table reads the same instance so
	// cooldown-benched deployments go unhealthy in the decision view
	cooldowns?: Cooldowns;
	now?: () => number;
	rng?: () => number;
	sleepMs?: (ms: number, signal?: AbortSignal) => Promise<void>;
	fetchImpl?: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
		connectMs?: number,
	) => Promise<Response>;
	metrics?: RouterMetrics;
	/** W1077: injectable liveness probe (tests stub it; default = a plain
	 *  GET /v1/models where any HTTP answer counts as live). */
	probe?: (dep: Deployment, signal?: AbortSignal) => Promise<Response | null>;
}
/** The resolved Router seam the purpose modules are free functions over:
 *  policy + deps plus the constructor-resolved cooldowns/now/rng/sleepMs/
 *  fetchImpl/metrics/pools. Router satisfies it structurally (W1299). */
export interface RouterHost {
	readonly policy: GatewayPolicy;
	/** The zod-parsed resilience block (Router resolves it once). */
	readonly resilience?: ResilienceConfig;
	readonly deps: RouterDeps;
	readonly cooldowns: Cooldowns;
	readonly now: () => number;
	readonly rng: () => number;
	readonly sleepMs: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly fetchImpl: (
		dep: Deployment,
		req: UpstreamRequest,
		timeoutMs: number,
		stream?: { idleMs: number; totalMs: number },
		connectMs?: number,
	) => Promise<Response>;
	readonly metrics?: RouterMetrics;
	readonly pools: Map<string, ProviderAdmissionCore>;
	/** Fleet-wide cap on immediate failover hops (keyed by requested group)
	 *  — a budget on hops, never on delayed retries (there are none). */
	readonly failover?: RetryBudget;
}
