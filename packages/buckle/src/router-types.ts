// src/router-types.ts — W1299 decomposition of router.ts (behavior identical):
// router contracts — public request/result types, walk state, the
// UpstreamError marker, and the RouterHost seam the purpose modules are
// written against.
import type { HopReceipt } from "../../telemetry/src/http-trace.ts";
import type {
	TransportEvidence,
	TransportObservation,
} from "../../telemetry/src/transport-evidence.ts";
import type { ErrorKind } from "./adapters/errors.ts";
import type { Cooldowns } from "./cooldown.ts";
import type { RouteSelection } from "./decide.ts";
import type { GatewayPolicy } from "./policy.ts";
import type { ProviderAdmissionCore } from "./provider-admission-core.ts";
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
	  }
	| {
			kind: "aborted";
	  }
	| {
			kind: "exhausted";
			status: number;
			error: string;
			attempts: number;
			lastFailure?: FailureProvenance;
			retryAfterS?: number;
	  };

interface FailureProvenance {
	source: "upstream" | "bridged-upstream" | "network" | "local-admission";
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
			upstreamRefusalCode?: string | null;
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
	deadlineMs: number;
	/** Account Retry-After or admission timeout cannot heal through an alias. */
	unavailablePools?: Set<string>;
	ctxWindow?: Response;
	rateLimit?: {
		response: Response;
		tier: string;
		source: "upstream" | "cooldown";
	};
	lastFailure?: FailureProvenance;
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
	) => Promise<Response>;
	readonly metrics?: RouterMetrics;
	readonly pools: Map<string, ProviderAdmissionCore>;
}
