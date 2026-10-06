import { describe, expect, test } from "bun:test";
import { endpointPassed, livenessResponse } from "../bin/health.ts";
import { httpProbe } from "../bin/supervisor.ts";
import { probeEndpoint } from "../bin/remotes.ts";

describe("process liveness contract", () => {
	for (const path of ["/health", "/health/liveness", "/health/liveliness"]) {
		test(`${path} supports GET and bodyless HEAD without dependency probes`, async () => {
			const response = livenessResponse(
				new Request(`http://service${path}`),
				"router",
			);
			expect(response?.status).toBe(200);
			expect(response?.headers.get("cache-control")).toBe("no-store");
			expect(await response?.json()).toMatchObject({
				ok: true,
				check: "process-liveness",
			});
			const head = livenessResponse(
				new Request(`http://service${path}`, { method: "HEAD" }),
				"router",
			);
			expect(head?.status).toBe(200);
			expect(await head?.text()).toBe("");
			expect(
				livenessResponse(
					new Request(`http://service${path}`, { method: "POST" }),
					"router",
				)?.status,
			).toBe(405);
		});
	}
});

describe("bounded endpoint verdicts", () => {
	test("remote routing candidates require a passing check, including authenticated models", async () => {
		let status = 200;
		let body = { ok: true };
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json(body, { status }),
		});
		const endpoint = {
			port: server.port,
			protocol: "openai" as const,
			roles: ["code"],
			base: `http://127.0.0.1:${server.port}/v1`,
			api_key: "fixture-key",
		};
		const machine = {
			name: "fixture",
			host: "127.0.0.1",
			endpoints: [endpoint],
		};
		try {
			expect(await probeEndpoint(machine, endpoint)).toBe(true);
			for (const failure of [401, 404, 503]) {
				status = failure;
				expect(await probeEndpoint(machine, endpoint)).toBe(false);
			}
			status = 200;
			body = { ok: false };
			expect(await probeEndpoint(machine, endpoint)).toBe(false);
		} finally {
			server.stop(true);
		}
	});
	for (const body of [
		{ ok: false },
		{ healthy: false },
		{ status: "down" },
		{ status: "unhealthy" },
	]) {
		test(`2xx cannot conceal ${JSON.stringify(body)}`, async () => {
			expect(await endpointPassed(Response.json(body))).toBe(false);
		});
	}
	test("plain responses and empty 204 are supported", async () => {
		expect(await endpointPassed(new Response("alive"))).toBe(true);
		expect(await endpointPassed(new Response(null, { status: 204 }))).toBe(
			true,
		);
		expect(await endpointPassed(Response.json({ data: [] }))).toBe(true);
	});
	test("oversized and malformed declared JSON are rejected", async () => {
		for (const body of ["null", "[]", "true", "1", '"alive"', ""]) {
			expect(
				await endpointPassed(
					new Response(body, {
						headers: { "content-type": "application/json" },
					}),
				),
			).toBe(false);
		}
		expect(
			await endpointPassed(Response.json({ detail: "x".repeat(70_000) })),
		).toBe(false);
		expect(
			await endpointPassed(
				new Response("broken", {
					headers: { "content-type": "application/json" },
				}),
			),
		).toBe(false);
	});
	test("strict supervisor probes reject false health and redirects, preserve auth liveness", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/redirect")
					return new Response(null, {
						status: 302,
						headers: { location: "/alive" },
					});
				if (path === "/auth")
					return new Response("auth required", { status: 401 });
				return Response.json({ ok: path === "/alive" });
			},
		});
		try {
			for (const path of ["/down", "/redirect"])
				expect(
					await httpProbe(server.port, path, "127.0.0.1", 1000, {
						okStatus: [200],
					}),
				).toBe(false);
			expect(
				await httpProbe(server.port, "/alive", "127.0.0.1", 1000, {
					okStatus: [200],
				}),
			).toBe(true);
			expect(
				await httpProbe(server.port, "/auth", "127.0.0.1", 1000, {
					okStatus: [200, 401],
				}),
			).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});
