// hooks/lib/front-probe.ts — the attributable buckle-front probe (W1124.43).
// The W1 probe (probeBuckleFront) answered one bit: front | null. The W1241
// dispatch (2026-10-23) rode the null as "front down" and took the solo
// belt-direct branch when the real failure was a 600 ms /status TIMEOUT —
// unreachable and auth answers were indistinguishable from a wedged server.
// This module keeps the probe's meaning (null = the front did not answer a
// plain GET /status inside the bound) but measures the failure: the verdict
// carries kind (ok|timeout|status|unreachable|abort), the HTTP status, the
// measured ms and the applied bound, so a refusal/belt-direct note says WHY.
//
// Outside-process health contract: the probe only ever trusts the WIRE
// answer (deploy/healthcheck/probe.ts doctrine — a server cannot paint
// itself healthy); a timeout is attributed to this probe's own bound, never
// upgraded to "front down" beyond what the wire showed. The bound is
// CONFIGURED, not blanket-raised: SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS, clamped
// to 100..10_000, default 600 (the historical W1 value, unchanged).
export const FRONT_PROBE_TIMEOUT_MS = 600;

// W1 dispatch-side adoption (finding.w1): lanes ride the buckle front with a
// /w/<slug> prefix so usage attributes per lane (route_audit.lane).
export const BUCKLE_FRONT =
	process.env.SUSPENDERS_BUCKLE_FRONT ?? "http://127.0.0.1:4101";

const FRONT_PROBE_TIMEOUT_MIN = 100;
const FRONT_PROBE_TIMEOUT_MAX = 10_000;

export type FrontProbeKind =
	| "ok"
	| "timeout"
	| "status"
	| "unreachable"
	| "abort";

/** One probe answer: what the wire (or the absence of one) showed. */
export interface FrontProbeVerdict {
	/** The front URL when the /status answer was 2xx, else null — the W1
	 *  probeBuckleFront contract, preserved verbatim. */
	front: string | null;
	ok: boolean;
	kind: FrontProbeKind;
	/** HTTP status when an answer arrived (0 = no answer on the wire). */
	status: number;
	/** Measured wall ms of the whole probe. */
	ms: number;
	/** The bound this probe applied (the configured bound). */
	boundMs: number;
	/** Human one-liner for dispatch/refusal notes; empty when ok. */
	note: string;
}

/** The configured probe bound: SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS, clamped
 *  to 100..10_000. Unset = 600 (W1 default, unchanged — no blanket raise);
 *  a non-numeric value falls back to the default; out-of-range values are
 *  clamped into range, never applied raw. */
export const frontTimeoutBound = (): number => {
	const raw = process.env.SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS;
	if (raw === undefined || raw.trim().length === 0)
		return FRONT_PROBE_TIMEOUT_MS;
	const n = Number(raw.trim());
	if (!Number.isFinite(n)) return FRONT_PROBE_TIMEOUT_MS;
	return Math.min(
		FRONT_PROBE_TIMEOUT_MAX,
		Math.max(FRONT_PROBE_TIMEOUT_MIN, Math.round(n)),
	);
};

/** Classify a probe rejection on its error name: TimeoutError = this
 *  probe's own bound fired; AbortError = a caller signal cancelled the
 *  probe (never miscounted as timeout); anything else = the wire refused
 *  (connection refused/reset, DNS). */
export const probeErrorKind = (
	e: unknown,
): "timeout" | "abort" | "unreachable" => {
	const name = e instanceof Error ? e.name : "";
	if (name === "TimeoutError") return "timeout";
	if (name === "AbortError") return "abort";
	return "unreachable";
};

/** The one wire call: GET <url> inside the bound, combining an optional
 *  caller abort with the timeout signal. Manual redirect — a front that
 *  answers a probe with a hub redirect is "status", not "ok". */
const wireAnswer = async (
	url: string,
	boundMs: number,
	signal?: AbortSignal,
): Promise<Response> =>
	fetch(url, {
		signal: signal
			? AbortSignal.any([AbortSignal.timeout(boundMs), signal])
			: AbortSignal.timeout(boundMs),
		redirect: "manual",
	});

/** The verdict probe: one GET <front>/status inside the configured bound,
 *  classified on the wire evidence. kind: ok = 2xx answer; timeout = the
 *  probe's own bound fired first; status = an HTTP answer outside 2xx (auth
 *  walls, 5xx — the front IS answering); unreachable = the wire refused;
 *  abort = a caller signal fired (never miscounted as timeout). */
export const probeBuckleFrontVerdict = async (
	front = BUCKLE_FRONT,
	signal?: AbortSignal,
): Promise<FrontProbeVerdict> => {
	const boundMs = frontTimeoutBound();
	const t0 = Date.now();
	const base = { front: null, ok: false, status: 0, ms: 0, boundMs, note: "" };
	try {
		const r = await wireAnswer(`${front}/status`, boundMs, signal);
		const ms = Date.now() - t0;
		if (r.ok)
			return { ...base, front, ok: true, kind: "ok", status: r.status, ms };
		return {
			...base,
			kind: "status",
			status: r.status,
			ms,
			note: `HTTP ${r.status} from ${front}/status in ${ms}ms`,
		};
	} catch (e) {
		const ms = Date.now() - t0;
		const kind = probeErrorKind(e);
		const name = e instanceof Error ? e.name : "network error";
		const note =
			kind === "timeout"
				? `timeout after ${ms}ms (bound ${boundMs}ms)`
				: kind === "abort"
					? `aborted after ${ms}ms`
					: `unreachable (${name || "network error"}) after ${ms}ms`;
		return { ...base, kind, ms, note };
	}
};

/** The W1 `string | null` contract, preserved: the front URL on a 2xx
 *  /status inside the bound, else null. Every existing caller keeps its
 *  meaning; callers that need the WHY read the verdict probe instead. */
export const probeBuckleFront = async (
	front = BUCKLE_FRONT,
): Promise<string | null> => (await probeBuckleFrontVerdict(front)).front;
