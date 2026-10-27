// review-quota.ts — W1313 quota-aware review-leg walk. The 2026-10-26
// 429 storm: the runner's flat 2-attempt loop re-fired the SAME model into a
// saturated upstream and recorded verdict ERROR wholesale (evidence: the
// work.review ERROR receipts carrying "Review LLM HTTP 429" all session).
// The walk adds what the scheduler's AIMD pause cannot: per-leg transport
// backoff (2s doubling, bounded) and a SECONDARY reviewer model walked after
// a sustained wall, with every attempt stamped into a retry trail the
// receipt + review fact carry.

export interface LegAttempt {
	/** Leg label (model for wire legs, target/bin for local legs). */
	leg: string;
	/** 1-based attempt number on this leg. */
	attempt: number;
	ok: boolean;
	/** Failure reason when ok=false (HTTP status, timeout, …). */
	error?: string;
	/** Wall time of the attempt. */
	ms: number;
}

export interface LegWalkResult {
	/** Every successful reply, in order — findings accumulate (W1236.1). */
	texts: string[];
	/** Last failure reason when no leg satisfied. */
	failure: string | null;
	trail: LegAttempt[];
	totalMs: number;
}

export interface WalkOptions {
	/** Ordered leg labels; index 0 = the pinned primary reviewer. */
	legLabels: string[];
	/** Transport retries per leg before walking to the next (default 3). */
	attemptsPerLeg?: number;
	/** Backoff before the next attempt on the SAME leg (default 2s doubling). */
	backoffMs?: (legIndex: number, attempt: number) => number;
	/** Await-able sleep; tests inject a no-op. */
	sleep?: (ms: number) => Promise<void>;
	/** A reply that fails this check is not final — walk on (default: any
	 * reply satisfies). */
	satisfied?: (text: string) => boolean;
	request: (legIndex: number, attempt: number) => Promise<string>;
}

/** Transport-class failures back off and retry / walk legs; terminal ones
 * (bad request, auth, route) move to the next leg immediately. 408/429 and
 * the 5xx family retry; the client-error family does not. */
export const isTransportFailure = (reason: string): boolean => {
	if (/HTTP \d{3}\b/.test(reason)) {
		if (/\bHTTP (400|401|402|403|404|405|413|422)\b/.test(reason)) return false;
		return /\bHTTP (408|429|5\d\d)\b/.test(reason);
	}
	return /\b(timed? ?out|timeout|abort|econn(reset|refused|aborted)|epipe|fetch failed|socket|network)\b/i.test(
		reason,
	);
};

/** 2s doubling to an 8s ceiling — enough to ride out a burst window, small
 * enough that the 25-minute scheduler lease stays the real bound. */
export const defaultBackoffMs = (_legIndex: number, attempt: number): number =>
	Math.min(8000, 2000 * 2 ** Math.max(0, attempt - 1));

const realSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Walk the ordered legs: transport failures retry the same leg with backoff,
 * a sustained wall (all attempts spent) or a terminal failure walks to the
 * next leg, and an unsatisfied reply (e.g. no verdict line) also walks on.
 * Attempts are bounded: legs × attemptsPerLeg LLM calls max. */
export async function walkLegs(o: WalkOptions): Promise<LegWalkResult> {
	const attemptsPerLeg = o.attemptsPerLeg ?? 3;
	const sleep = o.sleep ?? realSleep;
	const texts: string[] = [];
	const trail: LegAttempt[] = [];
	let failure: string | null = null;
	const t0 = Date.now();
	for (const legIndex of o.legLabels.keys()) {
		let legSpent = false;
		let transportTries = 0;
		let verdictTries = 0;
		for (let attempt = 1; !legSpent; attempt++) {
			const at = Date.now();
			try {
				const text = await o.request(legIndex, attempt);
				trail.push({
					leg: o.legLabels[legIndex],
					attempt,
					ok: true,
					ms: Date.now() - at,
				});
				texts.push(text);
				if (!o.satisfied || o.satisfied(text))
					return { texts, failure: null, trail, totalMs: Date.now() - t0 };
				verdictTries += 1;
				failure = "reply without the required verdict line";
				if (verdictTries >= 2) legSpent = true;
				else await sleep(20_000); // W1236 parity: bounded same-leg retry
			} catch (error) {
				const reason = String(error instanceof Error ? error.message : error);
				const transport = isTransportFailure(reason);
				trail.push({
					leg: o.legLabels[legIndex],
					attempt,
					ok: false,
					error: reason.slice(0, 160),
					ms: Date.now() - at,
				});
				failure = reason;
				if (!transport) break; // terminal on this leg — walk to the next
				transportTries += 1;
				if (transportTries >= attemptsPerLeg) legSpent = true;
				else await sleep((o.backoffMs ?? defaultBackoffMs)(legIndex, attempt));
			}
		}
	}
	return { texts, failure, trail, totalMs: Date.now() - t0 };
}

/** Compact machine-parseable one-liner for the receipt evidence line:
 * `trail: glm-5.3-flash#1:HTTP 429 -> glm-5.3-flash#2:ok (33.4s)`. */
export const renderTrail = (walk: {
	trail: LegAttempt[];
	totalMs: number;
}): string =>
	`trail: ${walk.trail
		.map(
			(a) => `${a.leg}#${a.attempt}${a.ok ? ":ok" : `:${a.error ?? "failed"}`}`,
		)
		.join(" -> ")} (${(walk.totalMs / 1000).toFixed(1)}s)`;

/** `SUSPENDERS_REVIEW_FALLBACK_MODELS` / `--fallback-models` CSV — ordered
 * secondary reviewer models after the primary hits a sustained wall. */
export const parseFallbackModels = (raw: string | undefined): string[] =>
	(raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
