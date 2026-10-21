import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsConnector } from "../src/metrics-connector.ts";
import { startServer } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "buckle-metrics-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const keyFile = join(dir, "litellm.key");
writeFileSync(keyFile, "metrics-test-token\n", { mode: 0o600 });

function gate(metrics: { url: string; keyFile: string }) {
	const cfg = join(dir, `upstreams-${crypto.randomUUID()}.yaml`);
	writeFileSync(
		cfg,
		"groups:\n  fixture:\n    - url: http://127.0.0.1:9\n      dialect: openai\n",
	);
	const server = startServer({
		port: 0,
		upstreamsPath: cfg,
		dbPath: ":memory:",
		auth: { rootKey: "fixture-root-key", metrics },
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

describe("Buckle private metrics connector", () => {
	test("admin GET joins Buckle and native LiteLLM metrics; public scrape stays Buckle-only", async () => {
		let upstreamAuth = "";
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				upstreamAuth = req.headers.get("authorization") ?? "";
				return new Response(
					"# TYPE litellm_proxy_total_requests_metric counter\nlitellm_proxy_total_requests_metric 7\n",
					{
						headers: { "content-type": "text/plain; version=0.0.4" },
					},
				);
			},
		});
		const app = gate({
			url: `http://127.0.0.1:${upstream.port}/metrics`,
			keyFile,
		});
		try {
			const bare = await fetch(`${app.base}/v1/admin/metrics`);
			expect(bare.status).toBe(401);
			const minted = await fetch(`${app.base}/v1/admin/keys`, {
				method: "POST",
				headers: { authorization: "Bearer fixture-root-key" },
				body: JSON.stringify({
					name: "proxy-only",
					scopes: ["buckle:proxy:WRITE_"],
				}),
			});
			const proxyKey = ((await minted.json()) as { key: string }).key;
			const forbidden = await fetch(`${app.base}/v1/admin/metrics`, {
				headers: { authorization: `Bearer ${proxyKey}` },
			});
			expect(forbidden.status).toBe(403);
			const publicMetrics = await (await fetch(`${app.base}/metrics`)).text();
			expect(publicMetrics).toContain("http_requests_total");
			expect(publicMetrics).not.toContain(
				"litellm_proxy_total_requests_metric",
			);
			const joined = await fetch(`${app.base}/v1/admin/metrics`, {
				headers: { authorization: "Bearer fixture-root-key" },
			});
			expect(joined.status).toBe(200);
			expect(joined.headers.get("x-buckle-litellm-metrics-status")).toBe("ok");
			const text = await joined.text();
			expect(text).toContain('buckle_metrics_source_up{source="buckle"} 1');
			expect(text).toContain('buckle_metrics_source_up{source="litellm"} 1');
			expect(text).toContain("http_requests_total");
			expect(text).toContain("litellm_proxy_total_requests_metric 7");
			expect(text).not.toContain("metrics-test-token");
			expect(upstreamAuth).toBe("Bearer metrics-test-token");
			const wrongMethod = await fetch(`${app.base}/v1/admin/metrics`, {
				method: "POST",
				headers: { authorization: "Bearer fixture-root-key" },
			});
			expect(wrongMethod.status).toBe(405);
			expect(wrongMethod.headers.get("allow")).toBe("GET, OPTIONS");
			const options = await fetch(`${app.base}/v1/admin/metrics`, {
				method: "OPTIONS",
			});
			expect(options.status).toBe(204);
		} finally {
			app.stop();
			upstream.stop(true);
		}
	});

	test("rejects non-loopback HTTP before sending a key", async () => {
		let called = false;
		const connector = new MetricsConnector({
			url: "http://192.0.2.1/metrics",
			keyFile,
			fetcher: () => {
				called = true;
				return Promise.resolve(new Response(""));
			},
		});
		const response = await connector.expose("buckle_counter 1\n");
		expect(called).toBe(false);
		expect(response.headers.get("x-buckle-litellm-metrics-status")).toBe(
			"invalid_config",
		);
		expect(await response.text()).toContain(
			'buckle_metrics_source_up{source="litellm"} 0',
		);
	});

	test("requires a 0600 regular key file and reports upstream failure without hiding Buckle", async () => {
		const publicKey = join(dir, "public.key");
		writeFileSync(publicKey, "should-not-leave\n", { mode: 0o644 });
		const connector = new MetricsConnector({
			url: "http://127.0.0.1:9/metrics",
			keyFile: publicKey,
		});
		const denied = await connector.expose("buckle_counter 1\n");
		expect(denied.headers.get("x-buckle-litellm-metrics-status")).toBe(
			"key_unavailable",
		);
		expect(await denied.text()).toContain("buckle_counter 1");
		const failed = await new MetricsConnector({
			url: "http://127.0.0.1:9/metrics",
			keyFile,
			timeoutMs: 50,
		}).expose("buckle_counter 1\n");
		expect(failed.headers.get("x-buckle-litellm-metrics-status")).toBe(
			"unavailable",
		);
	});

	test("caps upstream body size", async () => {
		const tooLarge = new MetricsConnector({
			url: "http://127.0.0.1:9/metrics",
			keyFile,
			maxBytes: 10,
			fetcher: async () =>
				new Response("12345678901", {
					headers: { "content-type": "text/plain" },
				}),
		});
		const response = await tooLarge.expose("buckle_counter 1\n");
		expect(response.headers.get("x-buckle-litellm-metrics-status")).toBe(
			"too_large",
		);
		expect(await response.text()).not.toContain("12345678901");
	});

	test("never follows redirects with the metrics key", async () => {
		let policy = "";
		const connector = new MetricsConnector({
			url: "http://127.0.0.1:9/metrics",
			keyFile,
			fetcher: async (_url, init) => {
				policy = init?.redirect ?? "";
				throw new Error("redirect rejected");
			},
		});
		const response = await connector.expose("buckle_counter 1\n");
		expect(policy).toBe("error");
		expect(response.headers.get("x-buckle-litellm-metrics-status")).toBe(
			"unavailable",
		);
	});

	test("times out a stalled scrape", async () => {
		const connector = new MetricsConnector({
			url: "http://127.0.0.1:9/metrics",
			keyFile,
			timeoutMs: 20,
			fetcher: (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		});
		const response = await connector.expose("buckle_counter 1\n");
		expect(response.headers.get("x-buckle-litellm-metrics-status")).toBe(
			"timeout",
		);
	});
});
