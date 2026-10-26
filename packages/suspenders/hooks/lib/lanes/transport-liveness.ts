// hooks/lib/lanes/transport-liveness.ts — W1302.5 transport cross-check for
// lane classification (O1, docs/workflow-adjustments-2026-10-25.md): W1217.1
// sat on a live 133s+ origin request at the buckle gate while every local
// signal (zero completed tokens, no source edits, stale transcript) read
// idle. The gate itself is the missing liveness term: rows in the W1259
// in-flight index (GET /v1/admin/inflight, buckle:admin:READ_ gate class)
// named for a lane's sid are production evidence — a zero-completed-token
// snapshot alone cannot classify the lane as idle. Missing evidence NEVER
// blocks: front down/401/timeout reads "unavailable", consumers keep their
// transcript/process verdicts (the fetchBuckleRouteAudit doctrine). The
// settled ring and route_audit are history, not production — only ACTIVE
// (queued/held/streaming) rows count.
import { adminKey, BUCKLE_FRONT } from "./lane-auth.ts";

/** Minimal row of GET /v1/admin/inflight `requests` (active entries only;
 *  the settled ring arrives in `recent` and is ignored here). */
export type InflightLaneRow = {
	lane: string;
	state: string;
	start_ms: number;
};

/** W1259 InflightState values that mean the request is still open. Settled
 *  and denied rows are history — never liveness evidence. */
export const ACTIVE_INFLIGHT_STATES = new Set(["queued", "held", "streaming"]);

/** Pure classifier: sid → an ACTIVE in-flight row names it. The exactness
 *  law (owner note #67628) keeps a still-open request in the active set
 *  with no age-based eviction, so the row's age never matters — the gate's
 *  own admission budgets bound a stuck row. */
export const transportAliveByLanes = (
	rows: readonly InflightLaneRow[],
): Map<string, boolean> => {
	const out = new Map<string, boolean>();
	for (const r of rows) {
		if (!r || typeof r.lane !== "string" || r.lane === "") continue;
		if (typeof r.state !== "string" || !ACTIVE_INFLIGHT_STATES.has(r.state))
			continue;
		out.set(r.lane, true);
	}
	return out;
};

/** One bounded, authenticated read of the in-flight index. Null = front
 *  down/401/timeout/odd shape — no evidence, never an empty history. */
export const fetchInflightLanes = async (
	front: string | null,
	token: string | null,
	timeoutMs = 2_000,
): Promise<InflightLaneRow[] | null> => {
	if (!front || !token) return null;
	try {
		const response = await fetch(new URL("/v1/admin/inflight", front), {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { authorization: `Bearer ${token}` },
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { requests?: unknown };
		if (!Array.isArray(body.requests)) return null;
		return body.requests as InflightLaneRow[];
	} catch {
		return null;
	}
};

export type InflightProbeResult = {
	/** false = the index was unreachable/unauthenticated/odd — consumers must
	 *  ignore `alive` entirely (missing evidence never blocks). */
	available: boolean;
	/** lane sid → an ACTIVE in-flight request exists at the gate. */
	alive: Map<string, boolean>;
};

export type TransportProbe = {
	/** lane sid → ACTIVE in-flight row at the gate (memoized ttlMs). */
	probe: () => Promise<InflightProbeResult>;
};

const UNAVAILABLE: InflightProbeResult = {
	available: false,
	alive: new Map(),
};

/** The fleet's ONE transport probe: one bounded index read per ttlMs window
 *  across every consumer in the process (stall-watch, reclaim sweep).
 *  SUSPENDERS_TRANSPORT_PROBE=0 disables (kill-switch — no fetch, always
 *  unavailable); front/key resolve at call time (W670 env-pinnable tests). */
export const createTransportProbe = (
	opts: {
		front?: () => string | null;
		token?: () => string | null;
		fetcher?: typeof fetchInflightLanes;
		ttlMs?: number;
	} = {},
): TransportProbe => {
	const front = opts.front ?? ((): string | null => BUCKLE_FRONT);
	const token = opts.token ?? ((): string | null => adminKey());
	const fetcher = opts.fetcher ?? fetchInflightLanes;
	const ttlMs =
		opts.ttlMs ??
		(Number(process.env.SUSPENDERS_TRANSPORT_PROBE_TTL_MS) || 30_000);
	let memo: { at: number; result: InflightProbeResult } | null = null;
	return {
		probe: async (): Promise<InflightProbeResult> => {
			if (process.env.SUSPENDERS_TRANSPORT_PROBE === "0") return UNAVAILABLE;
			if (memo && Date.now() - memo.at < ttlMs) return memo.result;
			const rows = await fetcher(front(), token());
			const result: InflightProbeResult =
				rows === null
					? UNAVAILABLE
					: { available: true, alive: transportAliveByLanes(rows) };
			memo = { at: Date.now(), result };
			return result;
		},
	};
};
