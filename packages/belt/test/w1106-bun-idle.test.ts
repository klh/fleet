// test/w1106-bun-idle.test.ts — W1106 owner directive 2026-10-21: NO Bun
// HTTP idle cutoff on any active inference hop, and no fixed client-side
// chat deadline. Bun ignores outgoing bytes when arming the idle timer
// (real-Bun canary), so any fixed value cuts quiet SSE turns (the ~120s
// fleet outage); app-level guards (Buckle wire.ts, AbortSignal on inventory
// polls) are the only deadlines. Behaviorized (W1135.2): the serve options
// each entry arms are captured from the REAL Bun.serve call (spy seam), the
// real buckle server boots, and the belt model-proxy runs as MAIN against a
// silent SSE upstream — a quiet turn past Bun's 10s default survives.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { scratchWorld } from "../../test-kit/src/index.ts";
import { join } from "node:path";
import { createModelProxy } from "../bin/model-proxy.ts";
import { startServer } from "../../buckle/src/server.ts";

// ── Bun.serve spy seam ─────────────────────────────────────────────
// The entrypoints arm their timers in Bun.serve(opts) at boot; the seam
// records the REAL options (never source text) and, in capture-only mode,
// stubs the server so a module-level serve never binds :4000/:7793.
type ServeOpts = Parameters<typeof Bun.serve>[0];
const captured: ServeOpts[] = [];
let passthrough = false;
const realServe = Bun.serve;
const stubServer = (opts: ServeOpts): { port: number } => ({
	port: opts.port ?? 0,
});
(Bun as unknown as { serve: unknown }).serve = (opts: ServeOpts) => {
	captured.push(opts);
	return passthrough ? realServe(opts) : stubServer(opts);
};

let routerServeOpts: ServeOpts | undefined;
let mcpServeOpts: ServeOpts | undefined;
const captureProblems: string[] = [];
try {
	// both entries serve at module top level — capture-only, never bound
	await import("../bin/router-shim.ts");
	routerServeOpts = captured.at(-1);
	await import("../bin/mcp-server.ts");
	mcpServeOpts = captured.at(-1);
} catch (error) {
	captureProblems.push(String(error));
} finally {
	passthrough = true;
}

const bin = (name: string): string =>
	new URL(`../bin/${name}`, import.meta.url).pathname;

/** Test upstream: chat goes silent past Bun's 10s idle default, then a
 *  second chunk arrives; /v1/models answers the readiness poll. */
function quietSseUpstream(): {
	port: number;
	stop(): void;
	secondAt(): number;
} {
	let secondAt = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch: (req) => {
			if (new URL(req.url).pathname === "/v1/models") {
				return Response.json({ data: [{ id: "m" }] });
			}
			return new Response(
				new ReadableStream({
					start(c) {
						const enc = new TextEncoder();
						c.enqueue(enc.encode('data: {"i":1}\n\n'));
						setTimeout(() => {
							secondAt = Date.now();
							c.enqueue(enc.encode('data: {"i":2}\n\n'));
							c.close();
						}, 11_000);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return {
		port: server.port,
		stop: () => server.stop(true),
		secondAt: () => secondAt,
	};
}

/** Env-pinned child running bin/model-proxy.ts as MAIN on a scratch port. */
function spawnProxyAsMain(
	upstreamPort: number,
	proxyPort: number,
	home: string,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn({
		cmd: [process.execPath, bin("model-proxy.ts")],
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			BELT_MODEL_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
			BELT_MODEL_PORT: String(proxyPort),
		},
		stdout: "ignore",
		stderr: "pipe",
	});
}

describe("W1106 Bun idle law on active inference hops", () => {
	test("buckle arms idleTimeout 0 for real and serves health on :0", async () => {
		const world = scratchWorld();
		const home = world.home;
		const upstreams = join(home, "upstreams.yaml");
		writeFileSync(
			upstreams,
			JSON.stringify({version:1,groups:{"glm-5.3-flash":[{url:"http://127.0.0.1:9",dialect:"openai"}]}}),
		);
		const before = captured.length;
		const server = startServer({
			port: 0,
			upstreamsPath: upstreams,
			dbPath: ":memory:",
			auth: { rootKey: "buckle-test-root" },
		});
		try {
			expect(server.port).toBeGreaterThan(0);
			const res = await fetch(`http://127.0.0.1:${server.port}/health`);
			expect(res.status).toBe(200);
		} finally {
			server.stop(true);
			world.clean();
		}
		// the REAL boot's serve options rode the spy — idle cutoff disabled
		const opts = captured[before];
		expect(opts?.idleTimeout).toBe(0);
		expect(opts?.hostname).toBe("127.0.0.1");
	});

	test("belt router-shim + mcp-server arm idleTimeout 0 at boot", () => {
		expect(captureProblems).toEqual([]);
		for (const opts of [routerServeOpts, mcpServeOpts]) {
			expect(opts, "capture from the real Bun.serve call").toBeDefined();
			expect(opts?.idleTimeout).toBe(0);
			expect(opts?.fetch).toBeTypeOf("function");
		}
		// W204: loopback-only binds
		expect(String(routerServeOpts?.hostname)).toBe("127.0.0.1");
		expect(String(mcpServeOpts?.hostname)).toBe("127.0.0.1");
	});

	test("the mcp-server handler answers a real Bun.serve socket", async () => {
		const host = realServe({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch: mcpServeOpts?.fetch,
		});
		try {
			// unconfigured posture (no BELT_MCP_* in the sandbox): the handler
			// answers the setup-needed shape — proof the wire is live
			const res = await fetch(`http://127.0.0.1:${host.port}/health`);
			expect(res.status).toBe(503);
			const body = (await res.json()) as { status?: string };
			expect(body.status).toBe("unconfigured");
		} finally {
			host.stop(true);
		}
	});

	test("model-proxy as MAIN survives a quiet SSE turn past the idle default", async () => {
			const world = scratchWorld();
			const home = world.home;
			const upstream = quietSseUpstream();
			const proxyPort = 21109 + (process.pid % 512);
			const child = spawnProxyAsMain(upstream.port, proxyPort, home);
			try {
				// readiness: inventory rides the child's real /v1/models path
				let ready = false;
				for (let i = 0; i < 50 && !ready; i++) {
					await Bun.sleep(100);
					ready = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`)
						.then((r) => r.ok, () => false);
				}
				if (!ready) {
					const err = await new Response(child.stderr).text();
					throw new Error(`model-proxy child never came up: ${err}`);
				}
				// quiet-turn probe, inline: chat through the child proxy, read
				// chunk one, hold silent past Bun's 10s idle default, get chunk 2
				const res = await fetch(
					`http://127.0.0.1:${proxyPort}/v1/chat/completions`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ model: "m", stream: true }),
					},
				);
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toContain(
					"text/event-stream",
				);
				const reader = res.body?.getReader();
				expect(reader).toBeDefined();
				const first = await reader?.read();
				expect(first?.done).toBe(false);
				// the quiet window: no reads, no writes — 11s of silence
				const second = await reader?.read();
				expect(second?.done).toBe(false);
				expect(upstream.secondAt()).toBeGreaterThan(0);
			} finally {
				child.kill();
				await child.exited;
				upstream.stop(true);
				world.clean();
			}
		},
		20_000,
	);

	test("model-proxy chat: client abort propagates into the upstream body", async () => {
		// one chunk, then silent-until-cancelled — cancel() firing proves
		// request.signal reached the upstream fetch (#55405: no fixed
		// deadline, cancellation preserved)
		let cancelled = false;
		const up = Bun.serve({
			port: 0,
			fetch: () => sseWithCancel(() => (cancelled = true)),
		});
		try {
			const proxy = createModelProxy({
				upstream: `http://127.0.0.1:${up.port}`,
			});
			const ac = new AbortController();
			const res = await proxy(
				new Request("http://belt.local/v1/chat/completions", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model: "m", stream: true }),
					signal: ac.signal,
				}),
			);
			expect(res.status).toBe(200);
			const reader = res.body?.getReader();
			await reader?.read();
			await ac.abort();
			for (let i = 0; i < 20 && !cancelled; i++) await Bun.sleep(25);
			expect(cancelled).toBe(true);
		} finally {
			up.stop(true);
		}
	});
});

/** SSE body with one chunk and a cancel observer (#55405 seam). */
function sseWithCancel(onCancel: () => void): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
			},
			cancel: onCancel,
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
