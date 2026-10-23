// src/eval/replay.ts — W1200 ledger-driven policy counterfactuals. Replays
// buckle route_attempt chains (per-rid, per-attempt outcomes from the LIVE
// ledger) through candidate routing-policy gateway knobs and scores the
// cost-fallback objective: success floor first, then cost (429-burn +
// failed-request token waste), then latency. Read-only over the ledger; no
// traffic, no live conf writes. Assumptions (declared in the hillclimb log):
// logged attempt outcomes are valid counterfactual samples (no second-order
// interference), streaming/non-streaming is not distinguishable per row, so
// the timeout knobs are out of scope; only the three retry/cooldown knobs
// carry ledger-visible signal.
import { Database } from "bun:sqlite";

export interface ReplayKnobs {
	num_retries: number;
	allowed_fails: number;
	cooldown_time: number;
}

export const BASELINE_KNOBS: ReplayKnobs = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
};

export interface AttemptRow {
	rid: string;
	ordinal: number;
	ts: string;
	candidate: string;
	status: number | null;
	duration_ms: number;
	retry_after_ms: number | null;
}

export interface RequestRow {
	rid: string;
	ts: string;
	ok: number | null;
	duration_ms: number | null;
	in_tok: number | null;
	out_tok: number | null;
}

export interface ReplayOutcome {
	success: boolean;
	burn429: number;
	durationMs: number;
	attempts: number;
}

export interface WindowMetrics {
	requests: number;
	successRate: number;
	burn429: number;
	cost: number;
	p50: number;
	p95: number;
}

export interface WindowSplit {
	train: WindowMetrics;
	test: WindowMetrics;
	trainRaw: WindowMetrics;
	testRaw: WindowMetrics;
	validity: {
		trainAgree: number;
		testAgree: number;
		requests: number;
		trainRequests: number;
		testRequests: number;
	};
}

/** Load in-window policy requests + their per-attempt chains. */
export function loadLedger(
	dbPath: string,
): {
	requests: RequestRow[];
	chains: Map<string, AttemptRow[]>;
	start: string;
	end: string;
} {
	const db = new Database(dbPath, { readonly: true });
	try {
		const reqs = db
			.query(
				`SELECT a.rid, a.ts, a.ok, a.duration_ms, a.in_tok, a.out_tok
				 FROM route_audit a
				 WHERE a.decision = 'policy' AND a.attempts IS NOT NULL
				 AND EXISTS (SELECT 1 FROM route_attempt r WHERE r.rid = a.rid)
				 ORDER BY a.ts`,
			)
			.all() as Array<Record<string, unknown>>;
		const chains = new Map<string, AttemptRow[]>();
		const rows = db
			.query(
				"SELECT rid, ordinal, ts, candidate, status, duration_ms, retry_after_ms FROM route_attempt ORDER BY rid, ordinal",
			)
			.all() as Array<Record<string, unknown>>;
		for (const r of rows) {
			const rid = String(r.rid);
			const list = chains.get(rid) ?? [];
			list.push({
				rid,
				ordinal: Number(r.ordinal),
				ts: String(r.ts),
				candidate: String(r.candidate ?? ""),
				status: r.status === null ? null : Number(r.status),
				duration_ms: Number(r.duration_ms ?? 0),
				retry_after_ms: r.retry_after_ms === null ? null : Number(r.retry_after_ms),
			});
			chains.set(rid, list);
		}
		const requests = reqs.map((r) => ({
			rid: String(r.rid),
			ts: String(r.ts),
			ok: r.ok === null ? null : Number(r.ok),
			duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
			in_tok: r.in_tok === null ? null : Number(r.in_tok),
			out_tok: r.out_tok === null ? null : Number(r.out_tok),
		}));
		return {
			requests,
			chains,
			start: requests[0]?.ts ?? "",
			end: requests[requests.length - 1]?.ts ?? "",
		};
	} finally {
		db.close();
	}
}

const okStatus = (s: number | null): boolean => s !== null && s >= 200 && s < 300;

/** Replay one request's chain under knobs. Shared breaker state rides the
 *  walk order (requests sorted by ts; chains walked per request). */
export function simulateRequest(
	chain: AttemptRow[],
	knobs: ReplayKnobs,
	state: { fails: Map<string, number>; until: Map<string, number> },
): ReplayOutcome {
	const out: ReplayOutcome = {
		success: false,
		burn429: 0,
		durationMs: 0,
		attempts: 0,
	};
	let prevCandidate: string | null = null;
	let rowRuns = 0;
	let cut = false;
	for (const a of chain) {
		const tsMs = Date.parse(a.ts);
		if (a.candidate === prevCandidate) {
			rowRuns++;
		} else {
			prevCandidate = a.candidate;
			rowRuns = 1;
			cut = false;
		}
		if (cut) continue;
		// per-row attempt budget: num_retries + 1
		if (rowRuns > knobs.num_retries + 1) {
			cut = true;
			continue;
		}
		// passive outlier ejection: benched row is walked past
		const blockedUntil = state.until.get(a.candidate);
		if (blockedUntil !== undefined && blockedUntil > tsMs) continue;
		out.attempts++;
		out.durationMs += a.duration_ms;
		if (okStatus(a.status)) {
			state.fails.set(a.candidate, 0);
			out.success = true;
			return out;
		}
		if (a.status === 429) out.burn429++;
		// any non-2xx counts toward the consecutive-fail breaker
		const n = (state.fails.get(a.candidate) ?? 0) + 1;
		if (n >= knobs.allowed_fails) {
			state.until.set(a.candidate, tsMs + knobs.cooldown_time * 1000);
			state.fails.set(a.candidate, 0);
		} else {
			state.fails.set(a.candidate, n);
		}
		// walk waits out the backoff before the next attempt on any row
		const waitMs =
			a.retry_after_ms ?? Math.min(2 ** Math.min(8, rowRuns), 8) * 1000;
		out.durationMs += waitMs;
	}
	return out;
}

/** Constant used to price a failed request's wasted tokens: the TRAIN
 *  baseline mean tokens per successful request. */
export const tokenPrice = (meanTokPerSuccess: number) => (fails: number) =>
	fails * meanTokPerSuccess;

export function aggregate(
	outcomes: ReplayOutcome[],
	meanTokPerSuccess: number,
): WindowMetrics {
	let success = 0;
	let burn = 0;
	let fails = 0;
	const durations: number[] = [];
	for (let i = 0; i < outcomes.length; i++) {
		if (outcomes[i].success) success++;
		else fails++;
		burn += outcomes[i].burn429;
		if (outcomes[i].attempts > 0) durations.push(outcomes[i].durationMs);
	}
	durations.sort((a, b) => a - b);
	const q = (p: number): number => {
		if (durations.length === 0) return 0;
		const idx = Math.min(durations.length - 1, Math.floor(p * (durations.length - 1)));
		return durations[idx];
	};
	return {
		requests: outcomes.length,
		successRate: outcomes.length === 0 ? 0 : success / outcomes.length,
		burn429: burn,
		cost: burn + fails * meanTokPerSuccess,
		p50: q(0.5),
		p95: q(0.95),
	};
}

/** Percentile of a sorted numeric array. */
export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.floor(p * (sorted.length - 1))),
	);
	return sorted[idx];
}

/** Replay a window (sorted requests) under knobs; breaker state is fresh. */
export function replayWindow(
	requests: RequestRow[],
	chains: Map<string, AttemptRow[]>,
	knobs: ReplayKnobs,
): ReplayOutcome[] {
	const state = { fails: new Map<string, number>(), until: new Map<string, number>() };
	const out: ReplayOutcome[] = [];
	for (const r of requests) {
		const chain = chains.get(r.rid);
		if (!chain) continue;
		out.push(simulateRequest(chain, knobs, state));
	}
	return out;
}

/** Split into TRAIN (older 2/3) + TEST (recent 1/3) at a ts boundary. */
export function splitWindows(
	requests: RequestRow[],
): { train: RequestRow[]; test: RequestRow[]; cutoff: string } {
	const n = requests.length;
	const cutIdx = Math.floor((n * 2) / 3);
	const cutoff = requests[cutIdx]?.ts ?? "";
	return {
		train: requests.slice(0, cutIdx),
		test: requests.slice(cutIdx),
		cutoff,
	};
}
