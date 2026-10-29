// src/latency-report.ts — W2247 diagnostic: matched request size vs
// first-byte latency over the route_attempt transport evidence. Answers
// "is a large request the cause of a slow first byte?" with numbers: the
// 2026-10-29 trace (912 KB body, headersMs 76562) was NOT size-driven —
// the request was non-streaming, so the provider sent no headers until the
// full completion was generated (4106 out-tokens at ~18.6 ms/token ≈ 76 s).
// Streaming semantics, prompt content and model choice are never touched.

export interface LatencyBucket {
	bucket: string;
	n: number;
	headersMs: { p50: number; p90: number; max: number };
	requestKbAvg: number;
	queueWaitMsP50: number | null;
}

export interface LatencyReport {
	attempts: number;
	pearsonRequestBytesHeadersMs: number;
	buckets: LatencyBucket[];
	streaming: { n: number; headersMsP50: number };
	nonStreaming: { n: number; headersMsP50: number };
}

const BUCKETS: ReadonlyArray<{ max: number; label: string }> = [
	{ max: 10_000, label: "<10k" },
	{ max: 100_000, label: "10-100k" },
	{ max: 500_000, label: "100-500k" },
	{ max: Number.MAX_SAFE_INTEGER, label: "500k+" },
];

const median = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.floor(sorted.length / 2)]);
};

const percentile = (values: number[], p: number): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))],
	);
};

const pearson = (points: Array<[number, number]>): number => {
	const n = points.length;
	if (n < 2) return Number.NaN;
	const mx = points.reduce((s, p) => s + p[0], 0) / n;
	const my = points.reduce((s, p) => s + p[1], 0) / n;
	let cov = 0;
	let sx = 0;
	let sy = 0;
	for (const [x, y] of points) {
		cov += (x - mx) * (y - my);
		sx += (x - mx) ** 2;
		sy += (y - my) ** 2;
	}
	return sx === 0 || sy === 0 ? Number.NaN : cov / Math.sqrt(sx * sy);
};

/** Rows = (transport_json, stream_receipt?, queue_wait_ms?) pulled by the
 *  caller — keeps this module pure and testable against a scratch db. */
export interface LatencyRow {
	transportJson: string | null;
	streamReceipt: unknown;
	queueWaitMs: number | null;
}

export function latencyReport(rows: LatencyRow[]): LatencyReport {
	const points: Array<[number, number]> = [];
	const buckets = new Map<
		string,
		{ hdr: number[]; kb: number[]; qw: number[] }
	>();
	const streamHdr: number[] = [];
	const nonStreamHdr: number[] = [];
	for (const row of rows) {
		const t = parseEvidence(row.transportJson);
		if (!t || t.headersMs === null) continue;
		points.push([t.requestBodyBytes, t.headersMs]);
		const label =
			BUCKETS.find((b) => t.requestBodyBytes <= b.max)?.label ?? "500k+";
		const entry = buckets.get(label) ?? { hdr: [], kb: [], qw: [] };
		entry.hdr.push(t.headersMs);
		entry.kb.push(t.requestBodyBytes / 1024);
		if (row.queueWaitMs !== null) entry.qw.push(row.queueWaitMs);
		buckets.set(label, entry);
		(row.streamReceipt ? streamHdr : nonStreamHdr).push(t.headersMs);
	}
	return {
		attempts: points.length,
		pearsonRequestBytesHeadersMs: pearson(points),
		buckets: [...buckets.entries()].map(([bucket, e]) => ({
			bucket,
			n: e.hdr.length,
			headersMs: {
				p50: median(e.hdr) ?? 0,
				p90: percentile(e.hdr, 0.9),
				max: Math.max(...e.hdr),
			},
			requestKbAvg: Math.round(
				e.kb.reduce((s, kb) => s + kb, 0) / (e.kb.length || 1),
			),
			queueWaitMsP50: median(e.qw),
		})),
		streaming: { n: streamHdr.length, headersMsP50: median(streamHdr) ?? 0 },
		nonStreaming: {
			n: nonStreamHdr.length,
			headersMsP50: median(nonStreamHdr) ?? 0,
		},
	};
}

interface Evidence {
	requestBodyBytes: number;
	headersMs: number | null;
}

function parseEvidence(json: string | null): Evidence | null {
	if (!json) return null;
	try {
		const v = JSON.parse(json) as Record<string, unknown>;
		const bytes = v.requestBodyBytes;
		const headersMs = v.headersMs;
		if (typeof bytes !== "number" || bytes < 0) return null;
		if (headersMs !== null && typeof headersMs !== "number") return null;
		return { requestBodyBytes: bytes, headersMs: headersMs ?? null };
	} catch {
		return null;
	}
}

export function renderReport(report: LatencyReport): string {
	const lines: string[] = [
		`attempts with transport evidence: ${report.attempts}`,
		`pearson r(requestBytes, headersMs): ${report.pearsonRequestBytesHeadersMs.toFixed(3)}`,
		`streaming headersMs p50: ${report.streaming.headersMsP50} ms (n=${report.streaming.n})`,
		`non-streaming headersMs p50: ${report.nonStreaming.headersMsP50} ms (n=${report.nonStreaming.n})`,
		"bucket      n      hdrMs p50/p90/max      reqKB avg   queueWait p50",
	];
	for (const b of [...report.buckets].sort((a, b) =>
		a.bucket.localeCompare(b.bucket),
	)) {
		lines.push(
			b.bucket.padEnd(11) +
				String(b.n).padStart(6) +
				`  ${b.headersMs.p50}/${b.headersMs.p90}/${b.headersMs.max}`.padStart(
					22,
				) +
				String(b.requestKbAvg).padStart(12) +
				String(b.queueWaitMsP50 ?? "—").padStart(15),
		);
	}
	return lines.join("\n");
}
