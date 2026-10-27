// hooks/lib/capacity/ramp-types.ts — W1713 shared shapes for the bounded
// capacity ramp: routes, outcome classes, per-request rows, per-step stats.
// Pure types + two tiny constants; no I/O.

export type RampWire = "messages" | "responses";

/** One ramped route: `model` is the gateway group id lanes send. */
export interface RampRoute {
	name: string;
	model: string;
	wire: RampWire;
}

/** Where a response came from. `local*` = the gateway refused (our budget);
 *  `provider*`/`upstream*` = the provider's own answer (their budget). */
export type OutcomeClass =
	| "ok"
	| "no_tool"
	| "provider429"
	| "local429"
	| "local503"
	| "local5xx"
	| "upstream5xx"
	| "client4xx"
	| "auth"
	| "timeout"
	| "network"
	| "aborted";

export const OUTCOME_CLASSES: readonly OutcomeClass[] = [
	"ok",
	"no_tool",
	"provider429",
	"local429",
	"local503",
	"local5xx",
	"upstream5xx",
	"client4xx",
	"auth",
	"timeout",
	"network",
	"aborted",
];

export interface Usage {
	/** non-cached input tokens (normalised: wire-specific totals folded) */
	fresh: number;
	cached: number;
	cacheWrite: number;
	out: number;
}

export interface RequestRow {
	runId: string;
	route: string;
	model: string;
	wire: RampWire;
	/** the step's target concurrency (virtual lanes in flight) */
	step: number;
	lane: string;
	startMs: number;
	ms: number;
	status: number | null;
	class: OutcomeClass;
	/** x-belt-error code the gateway stamped, when any */
	code: string | null;
	/** x-belt-route refusal origin: buckle|upstream|bridged-upstream|network|cooldown */
	refusal: string | null;
	retryAfterS: number | null;
	toolCalled: boolean;
	usage: Usage;
}

export interface InflightSample {
	atMs: number;
	/** this harness's own in-flight requests */
	own: number;
	/** gateway-wide active requests (every lane, from /v1/admin/inflight) */
	gateway: number | null;
	/** gateway rows whose lane is one of this run's virtual lanes */
	gatewayOwn: number | null;
	/** gateway rows on the ramped model (all lanes) */
	gatewayModel: number | null;
}

export type StopReason =
	| "provider429"
	| "local429"
	| "local503"
	| "error_rate"
	| "p95_latency"
	| "mint_refused"
	| "request_cap"
	| "time_cap"
	| "operator_abort";

export interface StopRules {
	maxP95Ms: number;
	maxErrPct: number;
	/** completed requests needed before a soft threshold can trip (throttles never wait) */
	minSamples: number;
}
