// src/otlp-export.ts — W2788 out-of-band per-request trace export: every
// proxied request settles one `buckle.proxy` span (wire-stamp settle point:
// trace id, hop, model_group, lane, key name, verdict) and, when usage is
// observed, one `buckle.usage` child span (OTel GenAI usage keys). Spans
// queue in a BOUNDED ring (drop-oldest, counted — streams over buffers) and
// flush in batches as OTLP/HTTP JSON to `${endpoint}/v1/traces`.
// Env-off by default: no BUCKLE_OTLP_ENDPOINT = no ring, no timer, no I/O.
// Export never blocks or fails a request — a collector miss drops the batch.
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const OtlpConfigSchema = z.object({
	endpoint: z.url(),
	sample: z.number().min(0).max(1),
	ring: z.number().int().min(1).max(65_536),
	batch: z.number().int().min(1).max(4096),
	flushMs: z.number().int().min(50),
	hub: z.string(),
});
export type OtlpConfig = z.infer<typeof OtlpConfigSchema>;

type Env = Record<string, string | undefined>;

const num = (v: string | undefined, d: number): number =>
	v === undefined || v.trim() === "" ? d : Number(v);

/** Env → config; null = export off (unset endpoint). Malformed knobs fail
 *  LOUD at boot (schema law) instead of exporting a half-configured feed. */
export function otlpConfigFromEnv(env: Env = process.env): OtlpConfig | null {
	const endpoint = env.BUCKLE_OTLP_ENDPOINT?.trim();
	if (!endpoint) return null;
	const parsed = OtlpConfigSchema.safeParse({
		endpoint: endpoint.replace(/\/+$/, ""),
		sample: num(env.BUCKLE_OTLP_SAMPLE, 1),
		ring: num(env.BUCKLE_OTLP_RING, 1024),
		batch: num(env.BUCKLE_OTLP_BATCH, 64),
		flushMs: num(env.BUCKLE_OTLP_FLUSH_MS, 2000),
		hub: env.BUCKLE_HUB_ID ?? "local",
	});
	if (!parsed.success)
		throw new Error(`BUCKLE_OTLP_*: ${z.prettifyError(parsed.error)}`);
	return parsed.data;
}

export type AttrValue = string | number | boolean;

export interface SpanInput {
	name: string;
	/** W3C traceparent the span belongs to (its parent-id = parentSpanId). */
	traceparent: string;
	/** Override the span id (the usage span parents on the proxy span). */
	spanId?: string;
	parentSpanId?: string;
	startMs: number;
	endMs: number;
	error: boolean;
	attrs: Record<string, AttrValue | null | undefined>;
}

type OtlpAttr = { key: string; value: Record<string, AttrValue> };

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttr[];
	status: { code: number };
}

const nanos = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;

function attrValue(v: AttrValue): Record<string, AttrValue> {
	if (typeof v === "boolean") return { boolValue: v };
	if (typeof v === "number")
		return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
	return { stringValue: v };
}

export function toOtlpSpan(s: SpanInput): OtlpSpan | null {
	const [, traceId, parentId] = s.traceparent.split("-");
	if (!traceId || !parentId) return null;
	const attributes: OtlpAttr[] = [];
	for (const [key, v] of Object.entries(s.attrs))
		if (v !== null && v !== undefined)
			attributes.push({ key, value: attrValue(v) });
	return {
		traceId,
		spanId: s.spanId ?? randomBytes(8).toString("hex"),
		parentSpanId: s.parentSpanId ?? parentId,
		name: s.name,
		kind: 2, // SPAN_KIND_SERVER
		startTimeUnixNano: nanos(s.startMs),
		endTimeUnixNano: nanos(s.endMs),
		attributes,
		status: { code: s.error ? 2 : 1 },
	};
}

export interface OtlpExporter {
	readonly config: OtlpConfig;
	/** Sampling is per TRACE (trace-id hash), so a request's spans travel
	 *  together. Returns false when the span was sampled out or invalid. */
	push(span: SpanInput): boolean;
	flush(): Promise<void>;
	stats(): { queued: number; dropped: number; sent: number; failed: number };
	stop(): Promise<void>;
}

/** Deterministic per-trace sampling: the low 32 bits of the trace id. */
export function sampled(traceId: string, rate: number): boolean {
	if (rate >= 1) return true;
	if (rate <= 0) return false;
	return Number.parseInt(traceId.slice(-8), 16) / 0x1_0000_0000 < rate;
}

export function createOtlpExporter(
	config: OtlpConfig,
	fetchImpl: typeof fetch = fetch,
): OtlpExporter {
	const ring: OtlpSpan[] = [];
	const counts = { dropped: 0, sent: 0, failed: 0 };
	let inflight: Promise<void> | null = null;
	const resource = {
		attributes: [
			{ key: "service.name", value: { stringValue: "buckle" } },
			{ key: "fleet.hub.id", value: { stringValue: config.hub } },
		],
	};
	const send = async (spans: OtlpSpan[]): Promise<void> => {
		try {
			const r = await fetchImpl(`${config.endpoint}/v1/traces`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					resourceSpans: [
						{
							resource,
							scopeSpans: [{ scope: { name: "klh.buckle" }, spans }],
						},
					],
				}),
				signal: AbortSignal.timeout(5000),
			});
			await r.body?.cancel();
			if (r.ok) counts.sent += spans.length;
			else counts.failed += spans.length;
		} catch {
			counts.failed += spans.length;
		}
	};
	const flush = async (): Promise<void> => {
		while (inflight) await inflight;
		while (ring.length > 0) {
			inflight = send(ring.splice(0, config.batch));
			await inflight;
			inflight = null;
		}
	};
	const timer = setInterval(() => {
		if (!inflight && ring.length > 0) void flush();
	}, config.flushMs);
	timer.unref();
	return {
		config,
		push(span) {
			const s = toOtlpSpan(span);
			if (!s || !sampled(s.traceId, config.sample)) return false;
			if (ring.length >= config.ring) {
				ring.shift();
				counts.dropped++;
			}
			ring.push(s);
			if (ring.length >= config.batch && !inflight) void flush();
			return true;
		},
		flush,
		stats: () => ({ queued: ring.length, ...counts }),
		async stop() {
			clearInterval(timer);
			await flush();
		},
	};
}

let active: OtlpExporter | null | undefined;

/** The process exporter (lazy from env; null = off). */
export function otlpExporter(): OtlpExporter | null {
	if (active === undefined) {
		const cfg = otlpConfigFromEnv();
		active = cfg ? createOtlpExporter(cfg) : null;
	}
	return active;
}

/** Test seam: install (or clear with null/undefined) the process exporter. */
export function setOtlpExporterForTest(
	e: OtlpExporter | null | undefined,
): void {
	active = e;
}
