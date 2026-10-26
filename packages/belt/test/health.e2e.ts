import { expect, test } from "@playwright/test";
import {
	endpointPassed,
	livenessResponse,
	modelEndpointHealth,
} from "../bin/health.ts";
import { httpProbe } from "../bin/supervisor.ts";
import { probeEndpoint } from "../bin/remotes.ts";
import { localProbe } from "../bin/route-policy.ts";
import { ensureAvailable } from "../bin/spawner.ts";
import { SPECIALISTS } from "../bin/registry.ts";

test.describe("process liveness contract", () => {
	for (const path of ["/health", "/health/liveness", "/health/liveliness"]) {
		test(`${path} supports GET and bodyless HEAD without dependency probes @unit`, async () => {
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

test.describe("bounded endpoint verdicts", () => {
	test("models fallback is only for an absent health route, never an unhealthy engine @unit", async () => {
		let status = 404;
		let modelReads = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/health")
					return new Response(null, { status });
				modelReads++;
				return Response.json({ data: [{ id: "fixture" }] });
			},
		});
		try {
			expect(await modelEndpointHealth(server.port)).toMatchObject({
				up: true,
				reachable: true,
			});
			expect(modelReads).toBe(1);
			status = 503;
			expect(await modelEndpointHealth(server.port)).toMatchObject({
				up: false,
				reachable: true,
			});
			expect(modelReads).toBe(1);
		} finally {
			server.stop(true);
		}
	});
	test("captured failed MLX lifecycle overrides healthy process and advertised models @unit", async () => {
		const captured = {
			status: "healthy",
			ready: true,
			model_loaded: false,
			model_lifecycle: {
				state: "error",
				model_loaded: false,
				error: "ImportError",
				active_request_owners: 0,
			},
		};
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request) =>
				Response.json(
					new URL(request.url).pathname === "/health"
						? captured
						: { data: [{ id: "fixture" }] },
				),
		});
		try {
			expect(await endpointPassed(Response.json(captured))).toBe(false);
			expect(await localProbe(server.port)).toBe(false);
			const specialist = SPECIALISTS[0];
			if (!specialist) throw Error("specialist missing");
			const availability = await ensureAvailable({
				...specialist,
				port: server.port,
			});
			expect(availability.up).toBe(false);
			expect(availability.warming).toBe(false);
			expect(availability.error).toContain("error");
		} finally {
			server.stop(true);
		}
	});
	test("unloaded alone is not an error, while explicit not-ready is unavailable @unit", async () => {
		expect(
			await endpointPassed(
				Response.json({
					status: "healthy",
					ready: true,
					model_loaded: false,
					model_lifecycle: {
						state: "unloaded",
						model_loaded: false,
						error: null,
					},
				}),
			),
		).toBe(true);
		expect(
			await endpointPassed(
				Response.json({
					status: "healthy",
					ready: false,
					model_lifecycle: { state: "loading", model_loaded: false },
				}),
			),
		).toBe(false);
		expect(
			await endpointPassed(
				Response.json({
					status: "healthy",
					ready: true,
					model_loaded: true,
					model_lifecycle: { state: "loaded", model_loaded: true },
				}),
			),
		).toBe(true);
	});
	test("real engine cold, loading and warm states do not launch a duplicate listener @unit", async () => {
		let state = "loading";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json({
					status: "healthy",
					ready: state !== "loading",
					model_loaded: state === "loaded",
					model_lifecycle: { state, error: null },
				}),
		});
		try {
			const specialist = SPECIALISTS[0];
			if (!specialist) throw Error("specialist missing");
			const row = { ...specialist, port: server.port };
			expect(await ensureAvailable(row)).toMatchObject({
				up: false,
				warming: true,
			});
			for (state of ["unloaded", "loaded"])
				expect(await ensureAvailable(row)).toMatchObject({
					up: true,
					warming: false,
				});
		} finally {
			server.stop(true);
		}
	});
	test("remote routing candidates require a passing check, including authenticated models @unit", async () => {
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
		test(`2xx cannot conceal ${JSON.stringify(body)} @unit`, async () => {
			expect(await endpointPassed(Response.json(body))).toBe(false);
		});
	}
	test("plain responses and empty 204 are supported @unit", async () => {
		expect(await endpointPassed(new Response("alive"))).toBe(true);
		expect(await endpointPassed(new Response(null, { status: 204 }))).toBe(
			true,
		);
		expect(await endpointPassed(Response.json({ data: [] }))).toBe(true);
	});
	test("oversized and malformed declared JSON are rejected @unit", async () => {
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
	test("strict supervisor probes reject false health and redirects, preserve auth liveness @unit", async () => {
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
