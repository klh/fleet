// Diagnostic request-loop probes retain any-response semantics when callers
// omit okStatus. Configured health/model checks explicitly narrow statuses;
// health.test.ts covers those strict consumer semantics.
import { describe, expect, test } from "bun:test";
import { httpProbe } from "../bin/supervisor.ts";

describe("W5: diagnostic httpProbe compatibility", () => {
	test("a 404 still demonstrates reachability when no statuses are specified", async () => {
		await using server = Bun.serve({
			port: 0,
			fetch: () => new Response("not found", { status: 404 }),
		});
		const up = await httpProbe(server.port, "/v1/models", "127.0.0.1", 2000);
		expect(up).toBe(true);
	});

	test("nothing listening on the port is down", async () => {
		// an unused high port — no server bound
		const up = await httpProbe(65100, "/v1/models", "127.0.0.1", 500);
		expect(up).toBe(false);
	});

	test("a slow (but alive) server within the 2000ms budget still counts as up", async () => {
		await using server = Bun.serve({
			port: 0,
			fetch: async () => {
				await new Promise((r) => setTimeout(r, 1200)); // > the old 800/1000ms timeouts, < 2000ms
				return new Response("ok");
			},
		});
		const up = await httpProbe(server.port, "/v1/models", "127.0.0.1", 2000);
		expect(up).toBe(true);
	});
});
