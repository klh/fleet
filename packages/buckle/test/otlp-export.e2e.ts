// W2788: out-of-band OTLP per-request trace export — env-off default,
// bounded drop-oldest ring, batched OTLP/HTTP JSON, per-trace sampling, and
// the proxy/usage spans parented on one trace (either settle order).
import { expect, test } from "@playwright/test";
import {
	createOtlpExporter,
	type OtlpConfig,
	otlpConfigFromEnv,
	sampled,
	setOtlpExporterForTest,
	type SpanInput,
} from "../src/otlp-export.ts";
import { exportProxySpan, exportUsageSpan } from "../src/otlp-request-spans.ts";
import type { Ctx } from "../src/request-context.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const TP = `00-${TRACE}-00f067aa0ba902b7-01`;
const cfg = (o: Partial<OtlpConfig> = {}): OtlpConfig => ({
	endpoint: "http://collector.invalid:4318",
	sample: 1,
	ring: 4,
	batch: 100,
	flushMs: 60_000,
	hub: "test",
	...o,
});
const span = (name: string): SpanInput => ({
	name,
	traceparent: TP,
	startMs: 1000,
	endMs: 1250,
	error: false,
	attrs: { "buckle.rid": name, skipped: null },
});

type Body = {
	resourceSpans: Array<{
		scopeSpans: Array<{
			spans: Array<{
				name: string;
				traceId: string;
				spanId: string;
				parentSpanId: string;
				startTimeUnixNano: string;
				attributes: Array<{ key: string; value: Record<string, unknown> }>;
			}>;
		}>;
	}>;
};
function capture(): { fetch: typeof fetch; posts: Array<[string, Body]> } {
	const posts: Array<[string, Body]> = [];
	const f = (async (url: string, init: RequestInit) => {
		posts.push([url, JSON.parse(String(init.body)) as Body]);
		return new Response("{}");
	}) as unknown as typeof fetch;
	return { fetch: f, posts };
}

test.describe("@unit otlp export", () => {
	test("env-off by default; malformed knobs fail loud", () => {
		expect(otlpConfigFromEnv({})).toBeNull();
		expect(otlpConfigFromEnv({ BUCKLE_OTLP_ENDPOINT: " " })).toBeNull();
		const c = otlpConfigFromEnv({
			BUCKLE_OTLP_ENDPOINT: "http://c.invalid:4318/",
			BUCKLE_OTLP_SAMPLE: "0.25",
		});
		expect(c?.endpoint).toBe("http://c.invalid:4318");
		expect(c?.sample).toBe(0.25);
		expect(() =>
			otlpConfigFromEnv({
				BUCKLE_OTLP_ENDPOINT: "http://c.invalid",
				BUCKLE_OTLP_SAMPLE: "2",
			}),
		).toThrow(/BUCKLE_OTLP_/);
	});

	test("bounded ring drops oldest and flushes one OTLP batch", async () => {
		const cap = capture();
		const ex = createOtlpExporter(cfg(), cap.fetch);
		for (const n of ["a", "b", "c", "d", "e", "f"]) ex.push(span(n));
		expect(ex.stats()).toMatchObject({ queued: 4, dropped: 2 });
		await ex.stop();
		expect(cap.posts).toHaveLength(1);
		const [url, body] = cap.posts[0];
		expect(url).toBe("http://collector.invalid:4318/v1/traces");
		const spans = body.resourceSpans[0].scopeSpans[0].spans;
		expect(spans.map((s) => s.name)).toEqual(["c", "d", "e", "f"]);
		expect(spans[0].traceId).toBe(TRACE);
		expect(spans[0].parentSpanId).toBe("00f067aa0ba902b7");
		expect(spans[0].startTimeUnixNano).toBe("1000000000");
		expect(spans[0].attributes.map((a) => a.key)).toEqual(["buckle.rid"]);
		expect(ex.stats()).toMatchObject({ queued: 0, sent: 4, failed: 0 });
	});

	test("collector failure counts, never throws", async () => {
		const ex = createOtlpExporter(cfg(), (async () => {
			throw new Error("down");
		}) as unknown as typeof fetch);
		ex.push(span("x"));
		await ex.stop();
		expect(ex.stats()).toMatchObject({ failed: 1, sent: 0 });
	});

	test("sampling is deterministic per trace id", () => {
		expect(sampled(TRACE, 1)).toBe(true);
		expect(sampled(TRACE, 0)).toBe(false);
		const low = `${"0".repeat(24)}00000001`;
		expect(sampled(low, 0.01)).toBe(true);
		expect(sampled(`${"0".repeat(24)}ffffffff`, 0.99)).toBe(false);
	});

	test("usage span parents on the proxy span in either settle order", async () => {
		const cap = capture();
		const ex = createOtlpExporter(cfg({ ring: 16 }), cap.fetch);
		setOtlpExporterForTest(ex);
		try {
			const ctx = {
				rid: "r1",
				group: "claude-sonnet-5",
				model: "claude-sonnet-5",
				lane: "w1",
				dialect: "anthropic",
				t0: 1000,
				trace: { traceparent: TP, baggage: null },
				hop: { peer: null },
				acct: { keyName: "fleet-ikea-lane" },
			} as unknown as Ctx;
			exportUsageSpan(ctx, { in_tok: 10, out_tok: 5, cache_r: 2, cache_c: 0 });
			exportProxySpan(ctx, { decision: "routed", status: 200, attempts: 1 });
			exportUsageSpan(ctx, null); // honest unknown: no span
			await ex.stop();
			const spans = cap.posts[0][1].resourceSpans[0].scopeSpans[0].spans;
			expect(spans.map((s) => s.name)).toEqual(["buckle.usage", "buckle.proxy"]);
			expect(spans[0].parentSpanId).toBe(spans[1].spanId);
			const attrs = Object.fromEntries(
				spans[1].attributes.map((a) => [a.key, Object.values(a.value)[0]]),
			);
			expect(attrs).toMatchObject({
				"buckle.key_name": "fleet-ikea-lane",
				"buckle.model_group": "claude-sonnet-5",
				"buckle.lane": "w1",
				"buckle.verdict": "routed",
				"http.response.status_code": 200,
			});
		} finally {
			setOtlpExporterForTest(undefined);
		}
	});
});
