// src/latency-report.ts — W2247/W2247.1 diagnostic: request size vs
// transport latency over the route_attempt transport evidence. headersMs
// and firstBodyByteMs are reported SEPARATELY and never conflated:
// headersMs is time-to-headers — for non-streaming requests it includes
// the whole generation (the 2026-10-29 trace: 912 KB body, headersMs
// 76562, non-streaming, 4106 out-tokens at ~18.6 ms/token ≈ 76 s) — so the
// historical size-vs-latency finding is a HEADERS finding. firstBodyByteMs
// is the actual first body byte and is aggregated from observed values
// only: rows without one are excluded, never backfilled from headersMs.
// Streaming semantics, prompt content and model choice are never touched.

export interface LatencyBucket {
	bucket: string;
	n: number;
	headersMs: { p50: number; p90: number; max: number };
	/** Observed first-body-byte times only; null when no row in the bucket
	 *  carried a firstBodyByteMs — never derived from headersMs. */
	firstBodyMs: { n: number; p50: number; p90: number; max: number } | null;
	requestKbAvg: number;
	queueWaitMsP50: number | null;
}

export interface LatencyReport {
	attempts: number;
	/** Headers-only correlation — the historical W2247 finding. */
	pearsonRequestBytesHeadersMs: number;
	/** null when fewer than 2 first-body observations — never fabricated. */
	pearsonRequestBytesFirstBodyMs: number | null;
	buckets: LatencyBucket[];
	/** null when NO row carried a firstBodyByteMs. */
	firstBodyByte: { n: number; p50: number; p90: number; max: number } | null;
	streaming: { n: number; headersMsP50: number };
	nonStreaming: { n: number; headersMsP50: number };
}

const BUCKETS: ReadonlyArray<{ max: number; label: string }> = [
	{ max: 10_000, label: "<10k" },
	{ max: 100_000, label: "10-100k" },
	{ max: 500_000, label: "100-500k" },
	{ max: Number.MAX_SAFE_INTEGER, label: "500k+" },
];

const nullIfNaN = (r: number): number | null => (Number.isNaN(r) ? null : r);

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
	const hdrPoints: Array<[number, number]> = [];
	const fbPoints: Array<[number, number]> = [];
	const buckets = new Map<
		string,
		{ hdr: number[]; fb: number[]; kb: number[]; qw: number[] }
	>();
	const streamHdr: number[] = [];
	const nonStreamHdr: number[] = [];
	const fbValues: number[] = [];
	for (const row of rows) {
		const t = parseEvidence(row.transportJson);
		if (!t || t.headersMs === null) continue;
		hdrPoints.push([t.requestBodyBytes, t.headersMs]);
		const label =
			BUCKETS.find((b) => t.requestBodyBytes <= b.max)?.label ?? "500k+";
		const entry = buckets.get(label) ?? { hdr: [], fb: [], kb: [], qw: [] };
		entry.hdr.push(t.headersMs);
		if (t.firstBodyByteMs !== null) {
			entry.fb.push(t.firstBodyByteMs);
			fbValues.push(t.firstBodyByteMs);
			fbPoints.push([t.requestBodyBytes, t.firstBodyByteMs]);
		}
		entry.kb.push(t.requestBodyBytes / 1024);
		if (row.queueWaitMs !== null) entry.qw.push(row.queueWaitMs);
		buckets.set(label, entry);
		(row.streamReceipt ? streamHdr : nonStreamHdr).push(t.headersMs);
	}
	return {
		attempts: hdrPoints.length,
		pearsonRequestBytesHeadersMs: pearson(hdrPoints),
		pearsonRequestBytesFirstBodyMs: nullIfNaN(pearson(fbPoints)),
		buckets: [...buckets.entries()].map(([bucket, e]) => ({
			bucket,
			n: e.hdr.length,
			headersMs: {
				p50: median(e.hdr) ?? 0,
				p90: percentile(e.hdr, 0.9),
				max: Math.max(...e.hdr),
			},
			firstBodyMs: e.fb.length
				? {
						n: e.fb.length,
						p50: median(e.fb) ?? 0,
						p90: percentile(e.fb, 0.9),
						max: Math.max(...e.fb),
					}
				: null,
			requestKbAvg: Math.round(
				e.kb.reduce((s, kb) => s + kb, 0) / (e.kb.length || 1),
			),
			queueWaitMsP50: median(e.qw),
		})),
		firstBodyByte: fbValues.length
			? {
					n: fbValues.length,
					p50: median(fbValues) ?? 0,
					p90: percentile(fbValues, 0.9),
					max: Math.max(...fbValues),
				}
			: null,
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
	firstBodyByteMs: number | null;
}

function parseEvidence(json: string | null): Evidence | null {
	if (!json) return null;
	try {
		const v = JSON.parse(json) as Record<string, unknown>;
		const bytes = v.requestBodyBytes;
		const headersMs = v.headersMs;
		const fb = v.firstBodyByteMs;
		if (typeof bytes !== "number" || bytes < 0) return null;
		if (headersMs !== null && typeof headersMs !== "number") return null;
		// absent/legacy rows carry no firstBodyByteMs — missing, not invalid
		const fbMs = fb === undefined || fb === null ? null : fb;
		if (fbMs !== null && typeof fbMs !== "number") return null;
		return {
			requestBodyBytes: bytes,
			headersMs: headersMs ?? null,
			firstBodyByteMs: fbMs,
		};
	} catch {
		return null;
	}
}

export function renderReport(report: LatencyReport): string {
	const lines: string[] = [
		`attempts with transport evidence: ${report.attempts}`,
		`pearson r(requestBytes, headersMs): ${report.pearsonRequestBytesHeadersMs.toFixed(3)} (headers only — non-streaming headersMs includes generation)`,
	];
	if (report.firstBodyByte) {
		lines.push(
			`first body byte ms: p50 ${report.firstBodyByte.p50} / p90 ${report.firstBodyByte.p90} / max ${report.firstBodyByte.max} (n=${report.firstBodyByte.n} of ${report.attempts})`,
		);
	} else {
		lines.push("first body byte ms: no first-body observations in window");
	}
	if (report.pearsonRequestBytesFirstBodyMs !== null) {
		lines.push(
			`pearson r(requestBytes, firstBodyByteMs): ${report.pearsonRequestBytesFirstBodyMs.toFixed(3)} (n=${report.firstBodyByte?.n ?? 0})`,
		);
	}
	lines.push(
		`streaming headersMs p50: ${report.streaming.headersMsP50} ms (n=${report.streaming.n})`,
		`non-streaming headersMs p50: ${report.nonStreaming.headersMsP50} ms (n=${report.nonStreaming.n})`,
		"bucket      n      hdrMs p50/p90/max     fbMs p50/p90/max   fb n      reqKB avg   queueWait p50",
	);
	for (const b of [...report.buckets].sort((a, b) =>
		a.bucket.localeCompare(b.bucket),
	)) {
		lines.push(
			b.bucket.padEnd(11) +
				String(b.n).padStart(6) +
				`  ${b.headersMs.p50}/${b.headersMs.p90}/${b.headersMs.max}`.padStart(
					22,
				) +
				(b.firstBodyMs
					? `  ${b.firstBodyMs.p50}/${b.firstBodyMs.p90}/${b.firstBodyMs.max}`.padStart(
							20,
						) + String(b.firstBodyMs.n).padStart(7)
					: "  —".padStart(20) + "      -".padStart(7)) +
				String(b.requestKbAvg).padStart(12) +
				String(b.queueWaitMsP50 ?? "—").padStart(15),
		);
	}
	return lines.join("\n");
}
