import { expect, test } from "./pw";
import {
	catalogRequest,
	createMonitor,
	type ProbeArgs,
	probeOnce,
	syntheticRequest,
} from "../deploy/healthcheck/probe.ts";
import { type ProbeDeps, probeService } from "../hooks/board/service-probe.ts";
import { servicemon } from "../hooks/lib/servicemon.ts";

test.describe("outside-process health", () => {
	test("live sidecar reports first failure, rejects wrong paths and supports safe methods", async () => {
		const target = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: false }),
		});
		const process = Bun.spawn(
			[
				"bun",
				`${import.meta.dir}/../deploy/healthcheck/probe.ts`,
				"--target",
				target.url.toString(),
				"--listen",
				"0",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		try {
			const output = await new Response(
				process.stdout.pipeThrough(
					new TransformStream({
						transform(chunk, controller) {
							controller.enqueue(chunk);
							controller.terminate();
						},
					}),
				),
			).text();
			const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
			if (!base) throw new Error("sidecar did not announce its port");
			expect((await fetch(`${base}/healthz`)).status).toBe(502);
			const head = await fetch(`${base}/status`, { method: "HEAD" });
			expect(head.status).toBe(502);
			expect(await head.text()).toBe("");
			expect(
				(await fetch(`${base}/healthz`, { method: "OPTIONS" })).status,
			).toBe(204);
			expect(
				(await fetch(`${base}/healthz`, { method: "DELETE" })).status,
			).toBe(405);
			expect((await fetch(`${base}/typo`)).status).toBe(404);
		} finally {
			process.kill();
			await process.exited;
			target.stop(true);
		}
	});
	test("rejects explicit false, malformed JSON and redirects while allowing plain liveness", async () => {
		let response = Response.json({ ok: false });
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => response.clone(),
		});
		try {
			const check = () => probeOnce(server.url.toString(), 500);
			expect((await check()).ok).toBe(false);
			response = Response.json({ healthy: false });
			expect((await check()).ok).toBe(false);
			response = new Response("broken", {
				headers: { "content-type": "application/json" },
			});
			expect((await check()).ok).toBe(false);
			response = Response.redirect(server.url.toString());
			expect((await check()).ok).toBe(false);
			response = new Response("ok");
			expect((await check()).ok).toBe(true);
			response = Response.json({ ok: true, padding: "x".repeat(65536) });
			expect((await check()).ok).toBe(false);
		} finally {
			server.stop(true);
		}
	});
	test("never vouches before success and degrades immediately on a missed sample", async () => {
		let up = false;
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: up }),
		});
		try {
			const monitor = createMonitor({
				target: server.url.toString(),
				every: 100,
				timeout: 100,
				misses: 3,
				ring: 2,
			});
			expect(monitor.snapshot().ok).toBe(false);
			await monitor.poll();
			expect(monitor.snapshot().ok).toBe(false);
			up = true;
			await monitor.poll();
			expect(monitor.snapshot().ok).toBe(true);
			up = false;
			await monitor.poll();
			expect(monitor.snapshot().state).toBe("degrading");
			expect(monitor.snapshot().ok).toBe(false);
			await monitor.poll();
			await monitor.poll();
			expect(monitor.snapshot().state).toBe("down");
			expect(monitor.snapshot().recent).toHaveLength(2);
			up = true;
			await monitor.poll();
			expect(monitor.snapshot().ok).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});

test.describe("status is telemetry with a fresh health verdict", () => {
	test("changes and throwing callbacks bypass the counter cache", async () => {
		let healthy = true;
		let fail = false;
		const sm = servicemon({
			service: "test",
			port: 0,
			refreshS: 60,
			healthy: () => {
				if (fail) throw new Error("health failed");
				return healthy;
			},
		});
		const handler = sm.fetch(() => new Response("ok"));
		const status = async () => {
			const response = await handler(new Request("http://localhost/status"));
			if (!response) throw new Error("missing status response");
			return response;
		};
		expect((await (await status()).json()).healthy).toBe(true);
		healthy = false;
		expect((await (await status()).json()).healthy).toBe(false);
		healthy = true;
		expect((await (await status()).json()).healthy).toBe(true);
		fail = true;
		const result = await status();
		expect(result?.status).toBe(200);
		expect((await result.json()).healthy).toBe(false);
		for (const path of ["/status", "/metrics"]) {
			expect(
				(
					await handler(
						new Request(`http://localhost${path}`, { method: "POST" }),
					)
				)?.status,
			).toBe(405);
			expect(
				(
					await handler(
						new Request(`http://localhost${path}`, { method: "OPTIONS" }),
					)
				)?.status,
			).toBe(204);
			expect(
				await (
					await handler(
						new Request(`http://localhost${path}`, { method: "HEAD" }),
					)
				)?.text(),
			).toBe("");
		}
	});
	test("board probes reject HTTP200 false verdicts", async () => {
		for (const body of [{ ok: false }, { healthy: false }]) {
			const deps: ProbeDeps = {
				fetch: async () => Response.json(body),
				launchctl: async () => ({ code: 1, out: "" }),
				now: () => new Date(),
			};
			const result = await probeService("buckle-4101", deps);
			expect(result?.state).toBe("degraded");
			expect(result?.up).toBe(false);
		}
	});
});

test.describe("synthetic readiness (W467)", () => {
	const readyBody = JSON.stringify({
		choices: [{ message: { content: "ready" } }],
	});

	test("POSTs the declared body with the bearer credential and demands the expect-path", async () => {
		let seen: { method?: string; auth?: string; traffic?: string } = {};
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				seen = {
					method: req.method,
					auth: req.headers.get("authorization") ?? undefined,
					traffic: req.headers.get("x-klh-traffic") ?? undefined,
				};
				return new Response(readyBody, {
					headers: { "content-type": "application/json" },
				});
			},
		});
		try {
			process.env.W467_TOKEN = "sk-test";
			const req = syntheticRequest(args(server.url.toString()));
			expect(req?.method).toBe("POST");
			expect(req?.headers?.authorization).toBe("Bearer sk-test");
			// W921: readiness traffic is marked so the gateway can tell the
			// synthetic full-chain poll apart from agent inference
			expect(req?.headers?.["x-klh-traffic"]).toBe("readiness");
			expect(req?.body).toContain("max_tokens");
			const ok = await probeOnce(server.url.toString(), 500, req);
			expect(ok.ok).toBe(true);
			expect(seen.method).toBe("POST");
			expect(seen.auth).toBe("Bearer sk-test");
			expect(seen.traffic).toBe("readiness");
		} finally {
			delete process.env.W467_TOKEN;
			server.stop(true);
		}
	});

	test("a missing expect-path answer and an unset AUTH_ENV both fail closed", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response(JSON.stringify({ error: { message: "boom" } }), {
					headers: { "content-type": "application/json" },
				}),
		});
		try {
			process.env.W467_TOKEN = "sk-test";
			const noPath = await probeOnce(
				server.url.toString(),
				500,
				syntheticRequest(args(server.url.toString())),
			);
			expect(noPath.ok).toBe(false);
			delete process.env.W467_TOKEN;
			const monitor = createMonitor(args(server.url.toString()));
			await monitor.poll();
			const snap = monitor.snapshot();
			expect(snap.ok).toBe(false);
			expect(snap.mode).toBe("synthetic");
			expect(snap.check).toBe("inference-route");
			expect(snap.intervalMs).toBe(1);
			expect(snap.error).toContain("W467_TOKEN");
		} finally {
			delete process.env.W467_TOKEN;
			server.stop(true);
		}
	});

	test("a failed synthetic sample confirms with the same classified POST", async () => {
		const methods: string[] = [];
		const traffic: (string | null)[] = [];
		let calls = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				methods.push(req.method);
				traffic.push(req.headers.get("x-klh-traffic"));
				calls++;
				return new Response(calls === 2 ? "unavailable" : readyBody, {
					status: calls === 2 ? 503 : 200,
					headers: { "content-type": "application/json" },
				});
			},
		});
		try {
			process.env.W467_TOKEN = "sk-test";
			const monitor = createMonitor(args(server.url.toString()));
			await monitor.poll();
			await monitor.poll();
			expect(monitor.snapshot().state).toBe("up");
			expect(methods).toEqual(["POST", "POST", "POST"]);
			expect(traffic).toEqual(["readiness", "readiness", "readiness"]);
		} finally {
			delete process.env.W467_TOKEN;
			server.stop(true);
		}
	});
});

test.describe("token-free route catalog", () => {
	test("checks the exact model with an authenticated GET and leaves inference unknown", async () => {
		const seen: Array<{ method: string; auth: string | null }> = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				seen.push({
					method: req.method,
					auth: req.headers.get("authorization"),
				});
				return Response.json({ data: [{ id: "claude-sonnet-5" }] });
			},
		});
		try {
			process.env.W1004_TOKEN = "test-token";
			const config = {
				...args(server.url.toString()),
				synthetic: undefined,
				authEnv: "W1004_TOKEN",
				catalogModel: "claude-sonnet-5",
			};
			const monitor = createMonitor(config);
			await monitor.poll();
			const snap = monitor.snapshot();
			expect(snap.ok).toBe(true);
			expect(snap.check).toBe("route-catalog");
			expect(snap.inferenceAvailability).toBe("unknown");
			expect(seen).toEqual([{ method: "GET", auth: "Bearer test-token" }]);
		} finally {
			delete process.env.W1004_TOKEN;
			server.stop(true);
		}
	});

	test("missing model or credential fails closed; inference 429 is a separate signal", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => Response.json({ data: [{ id: "other" }] }),
		});
		try {
			const config = {
				...args(server.url.toString()),
				synthetic: undefined,
				authEnv: "W1004_TOKEN",
				catalogModel: "claude-sonnet-5",
			};
			process.env.W1004_TOKEN = "test-token";
			expect(
				(await probeOnce(server.url.toString(), 500, catalogRequest(config)))
					.ok,
			).toBe(false);
			delete process.env.W1004_TOKEN;
			const monitor = createMonitor(config);
			await monitor.poll();
			expect(monitor.snapshot().ok).toBe(false);
			expect(monitor.snapshot().error).toContain("W1004_TOKEN");
		} finally {
			delete process.env.W1004_TOKEN;
			server.stop(true);
		}
		const quota = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response("quota", { status: 429 }),
		});
		try {
			const monitor = createMonitor({
				...args(quota.url.toString()),
				authEnv: undefined,
			});
			await monitor.poll();
			expect(monitor.snapshot().inferenceAvailability).toBe("quota-blocked");
			await Bun.sleep(10);
			expect(monitor.snapshot().inferenceAvailability).toBe("unknown");
		} finally {
			quota.stop(true);
		}
	});
});

function args(target: string): ProbeArgs {
	return {
		target,
		every: 1,
		timeout: 1,
		misses: 1,
		ring: 1,
		synthetic: '{"model":"general","max_tokens":4}',
		authEnv: "W467_TOKEN",
		expect: "choices.0",
	};
}
