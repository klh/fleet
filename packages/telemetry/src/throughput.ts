/** Body-free, node-local settled-request evidence. A hop is not a second
 * client request: retain trace/call IDs for federated deduplication. */
export interface ThroughputSample {
	id: string;
	traceId: string | null;
	callId: string | null;
	node: string;
	at: number;
	requestedGroup: string | null;
	model: string | null;
	provider: string | null;
	providerProfile: string | null;
	effort: string | null;
	context: string | null;
	ok: boolean;
	attempts: number;
	queueMs: number | null;
	serviceMs: number | null;
	totalMs: number;
	outTokens: number | null;
	demand: boolean;
	paused: boolean;
}

export interface ThroughputPolicy {
	bucketMs: number;
	retentionBuckets: number;
	maxDimensions: number;
	maxSamplesPerBucket: number;
	minSamples: number;
	baselineBuckets: number;
	dropPercent: number;
	sustainBuckets: number;
	recoveryPercent: number;
	recoveryBuckets: number;
	alpha: number;
}

export const DEFAULT_THROUGHPUT_POLICY: ThroughputPolicy = {
	bucketMs: 60_000,
	retentionBuckets: 120,
	maxDimensions: 128,
	maxSamplesPerBucket: 4096,
	minSamples: 20,
	baselineBuckets: 8,
	dropPercent: 50,
	sustainBuckets: 3,
	recoveryPercent: 75,
	recoveryBuckets: 2,
	alpha: 0.2,
};

export function assertThroughputPolicy(
	value: unknown,
): asserts value is ThroughputPolicy {
	if (!value || typeof value !== "object")
		throw new Error("throughput: policy must be an object");
	const p = value as ThroughputPolicy;
	if (Object.keys(p).length !== 11)
		throw new Error("throughput: complete bounded policy required");
	for (const name of [
		"bucketMs",
		"retentionBuckets",
		"maxDimensions",
		"maxSamplesPerBucket",
		"minSamples",
		"baselineBuckets",
		"sustainBuckets",
		"recoveryBuckets",
	] as const)
		if (!Number.isSafeInteger(p[name]) || p[name] < 1)
			throw new Error(`throughput: invalid ${name}`);
	if (
		![p.alpha, p.dropPercent, p.recoveryPercent].every(Number.isFinite) ||
		p.alpha <= 0 ||
		p.alpha > 1 ||
		p.dropPercent <= 0 ||
		p.dropPercent >= 100 ||
		p.recoveryPercent <= 100 - p.dropPercent ||
		p.recoveryPercent > 100
	)
		throw new Error("throughput: invalid degradation hysteresis");
	if (
		p.retentionBuckets * p.maxDimensions > 20_000 ||
		p.maxSamplesPerBucket > 20_000
	)
		throw new Error(
			"throughput: telemetry retention/cardinality budget exceeded",
		);
}

export interface ThroughputBucket {
	saturated?: boolean;
	node: string;
	bucket: number;
	key: string;
	group: string | null;
	model: string | null;
	provider: string | null;
	providerProfile: string | null;
	effort: string | null;
	context: string | null;
	requests: number;
	successes: number;
	failures: number;
	attempts: number;
	retries: number;
	knownUsage: number;
	unknownUsage: number;
	outTokens: number;
	knownServiceMs: number;
	serviceTokens: number;
	serviceSamples: number;
	matchedTotalMs: number;
	queueMs: number;
	queueSamples: number;
	totalMs: number;
	demandSamples: number;
	paused: boolean;
	lastAt: number;
}

/** Exact comparable cohort, including unknowns as null rather than a
 * guessed provider or zero-token model. Labels never contain prompts. */
export function throughputKey(s: ThroughputSample): string {
	return JSON.stringify([
		s.requestedGroup,
		s.model,
		s.provider,
		s.providerProfile,
		s.effort,
		s.context,
	]);
}

export function addThroughputSample(
	old: ThroughputBucket | null,
	s: ThroughputSample,
	p: ThroughputPolicy,
): ThroughputBucket {
	const b: ThroughputBucket = old
		? { ...old }
		: {
				node: s.node,
				bucket: Math.floor(s.at / p.bucketMs) * p.bucketMs,
				key: throughputKey(s),
				group: s.requestedGroup,
				model: s.model,
				provider: s.provider,
				providerProfile: s.providerProfile,
				effort: s.effort,
				context: s.context,
				requests: 0,
				successes: 0,
				failures: 0,
				attempts: 0,
				retries: 0,
				knownUsage: 0,
				unknownUsage: 0,
				outTokens: 0,
				knownServiceMs: 0,
				serviceTokens: 0,
				serviceSamples: 0,
				matchedTotalMs: 0,
				queueMs: 0,
				queueSamples: 0,
				totalMs: 0,
				demandSamples: 0,
				paused: false,
				lastAt: s.at,
			};
	b.requests++;
	if (s.ok) b.successes++;
	else b.failures++;
	b.attempts += s.attempts;
	b.retries += Math.max(0, s.attempts - 1);
	b.totalMs += s.totalMs;
	if (s.outTokens === null) b.unknownUsage++;
	else {
		b.knownUsage++;
		b.outTokens += s.outTokens;
	}
	if (s.queueMs !== null) {
		b.queueMs += s.queueMs;
		b.queueSamples++;
	}
	if (s.ok && s.outTokens !== null && s.serviceMs !== null && s.serviceMs > 0) {
		b.serviceTokens += s.outTokens;
		b.knownServiceMs += s.serviceMs;
		b.serviceSamples++;
		b.matchedTotalMs += s.totalMs;
	}
	if (s.demand) b.demandSamples++;
	b.paused ||= s.paused;
	b.lastAt = Math.max(b.lastAt, s.at);
	return b;
}

export interface ThroughputBaseline {
	rate: number;
	endToEndRate: number;
	buckets: number;
	samples: number;
	lastBucket: number;
	low: number;
	healthy: number;
	incident: boolean;
}

export interface ThroughputEvaluation {
	baseline: ThroughputBaseline | null;
	state: "unknown" | "warming" | "healthy" | "degraded";
	transition: "warning" | "recovery" | null;
	rate: number | null;
	endToEndRate: number | null;
	ratio: number | null;
	reason: string | null;
}

/** A capacity comparison needs offered demand, enough successful reported
 * usage and a known route. No idle decay, stale training or zero-fill. */
export function evaluateThroughput(
	b: ThroughputBucket,
	previous: ThroughputBaseline | null,
	p: ThroughputPolicy,
	now: number,
): ThroughputEvaluation {
	const rate =
		b.knownServiceMs > 0 ? (b.serviceTokens * 1000) / b.knownServiceMs : null;
	const endToEndRate =
		b.matchedTotalMs > 0 ? (b.serviceTokens * 1000) / b.matchedTotalMs : null;
	const unknown = (reason: string): ThroughputEvaluation => ({
		baseline:
			previous && b.bucket + p.bucketMs <= now
				? {
						...previous,
						low: 0,
						healthy: 0,
						lastBucket: Math.max(previous.lastBucket, b.bucket),
					}
				: previous,
		state: "unknown",
		transition: null,
		rate,
		endToEndRate,
		ratio: null,
		reason,
	});
	if (previous && b.bucket <= previous.lastBucket)
		return {
			baseline: previous,
			state:
				now - b.lastAt > p.bucketMs * 2
					? "unknown"
					: previous.incident
						? "degraded"
						: previous.buckets >= p.baselineBuckets
							? "healthy"
							: "warming",
			transition: null,
			rate,
			endToEndRate,
			ratio:
				rate === null || endToEndRate === null
					? null
					: Math.min(
							rate / previous.rate,
							endToEndRate / previous.endToEndRate,
						),
			reason: "already_processed",
		};
	if (b.bucket + p.bucketMs > now) return unknown("open_bucket");
	if (b.saturated) return unknown("capacity_lost");
	if (now - b.lastAt > p.bucketMs * 2) return unknown("stale");
	if (b.paused) return unknown("paused");
	if (!b.model || !b.provider) return unknown("unknown_route");
	if (!b.demandSamples) return unknown("no_observed_demand");
	if (
		b.serviceSamples < p.minSamples ||
		b.knownUsage !== b.requests ||
		rate === null ||
		rate <= 0 ||
		endToEndRate === null ||
		endToEndRate <= 0
	)
		return unknown("insufficient_reported_samples");
	const n: ThroughputBaseline = previous
		? { ...previous }
		: {
				rate,
				endToEndRate,
				buckets: 0,
				samples: 0,
				lastBucket: b.bucket,
				low: 0,
				healthy: 0,
				incident: false,
			};
	const serviceRatio = previous ? rate / previous.rate : null;
	const endToEndRatio = previous ? endToEndRate / previous.endToEndRate : null;
	const ratio =
		serviceRatio === null || endToEndRatio === null
			? null
			: Math.min(serviceRatio, endToEndRatio);
	let transition: ThroughputEvaluation["transition"] = null;
	const comparable = n.buckets >= p.baselineBuckets;
	if (comparable && ratio !== null && ratio <= 1 - p.dropPercent / 100) {
		n.low++;
		n.healthy = 0;
		if (n.low >= p.sustainBuckets && !n.incident) {
			n.incident = true;
			transition = "warning";
		}
	} else {
		n.low = 0;
		if (n.incident && ratio !== null && ratio >= p.recoveryPercent / 100) {
			if (++n.healthy >= p.recoveryBuckets) {
				n.incident = false;
				transition = "recovery";
			}
		} else n.healthy = 0;
		// Freeze the reference on suspected drops and throughout the incident.
		if (!n.incident && transition !== "recovery") {
			n.rate = n.rate * (1 - p.alpha) + rate * p.alpha;
			n.endToEndRate = n.endToEndRate * (1 - p.alpha) + endToEndRate * p.alpha;
		}
	}
	n.buckets++;
	n.samples += b.serviceSamples;
	n.lastBucket = b.bucket;
	return {
		baseline: n,
		state: n.incident ? "degraded" : comparable ? "healthy" : "warming",
		transition,
		rate,
		endToEndRate,
		ratio,
		reason:
			ratio !== null && ratio <= 1 - p.dropPercent / 100
				? serviceRatio !== null && serviceRatio <= 1 - p.dropPercent / 100
					? "upstream_service_slow"
					: "queue_or_admission_slow"
				: null,
	};
}
