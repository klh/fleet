// W257 — per-request server timings: viaLocal/openLocalStream measurement,
// translator `_server_timings` emission, and the shim's JSON + stream
// surfaces. Stub servers only — never the live :890x fleet.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	anthropicSseFromText,
	anthropicSseFromOpenAi,
	type RequestTimings,
	viaLocal,
	openLocalStream,
} from "../bin/router-core.ts";

const sse = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const parseSse = (text: string): Array<{ ev: string; data: unknown }> =>
	text
		.split("\n\n")
		.filter(Boolean)
		.map((blk) => {
			const lines = blk.split("\n");
			const ev = lines.find((l) => l.startsWith("event:"))?.slice(7) ?? "";
			const data = lines.find((l) => l.startsWith("data:"))?.slice(6) ?? "{}";
			return { ev, data: JSON.parse(data) };
		});

// shared stub upstream (OpenAI wire): buffered "pong" or a two-delta stream
const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		const b = (await req.json()) as { stream?: boolean };
		if (!b.stream)
			return Response.json({
				choices: [{ finish_reason: "stop", message: { content: "pong" } }],
			});
		const stream = new ReadableStream({
			async start(c) {
				const enc = new TextEncoder();
				c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "he" } }] })));
				await Bun.sleep(120);
				c.enqueue(
					enc.encode(sse({ choices: [{ delta: { content: "llo" } }] })),
				);
				await Bun.sleep(60);
				c.enqueue(
					enc.encode(sse({ choices: [], usage: { completion_tokens: 5 } })),
				);
				c.enqueue(enc.encode("data: [DONE]\n\n"));
				c.close();
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		});
	},
});
const stubBase = `http://127.0.0.1:${stub.port}`;
test.afterAll(() => stub.stop(true));

test.describe("per-request timings (W257)", () => {
	test("viaLocal reports total/prefill from startedAt @unit", async () => {
		const r = await viaLocal({ port: 1, model: "m" }, [], 10, 0, {
			base: stubBase,
			startedAt: performance.now() - 5,
		});
		expect(r.ok).toBe(true);
		expect(r.timings?.total_ms).toBeGreaterThanOrEqual(
			r.timings?.prefill_ms ?? 0,
		);
		expect(r.timings?.prefill_ms).toBeGreaterThanOrEqual(0);
		// a buffered completion hides decode inside prefill — absent, not zero
		expect(r.timings?.ttft_ms).toBeUndefined();
		expect(r.timings?.decode_ms).toBeUndefined();
	});

	test("viaLocal without startedAt → no timings (back-compat) @unit", async () => {
		const r = await viaLocal({ port: 1, model: "m" }, [], 10, 0, {
			base: stubBase,
		});
		expect(r.ok).toBe(true);
		expect(r.timings).toBeUndefined();
	});

	test("openLocalStream stamps openedAt when startedAt is set @unit", async () => {
		const r = await openLocalStream({ port: 1, model: "m" }, [], 10, 0, {
			base: stubBase,
			startedAt: performance.now() - 5,
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.openedAt).toBeGreaterThan(0);
			await r.body.cancel();
		}
	});
});

// W257 stream meta: t0 10 ms back, upstream opened 8 ms back
const streamMeta = () => ({
	id: "msg_t",
	model: "x",
	routing: { port: 8901 },
	startedAt: performance.now() - 10,
	openedAt: performance.now() - 8,
});

test.describe("translator `_server_timings` (W257)", () => {
	test("live stream: tail usage carries timings, order unchanged @unit", async () => {
		const up = await fetch(`${stubBase}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
		});
		const res = new Response(
			anthropicSseFromOpenAi(up.body ?? new ReadableStream(), streamMeta()),
		);
		const events = parseSse(await res.text());
		expect(events.map((e) => e.ev)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		const md = events.find((e) => e.ev === "message_delta")?.data as {
			usage: { _server_timings?: RequestTimings };
		};
		const t = md.usage._server_timings;
		expect(t).toBeDefined();
		expect(t?.total_ms).toBeGreaterThanOrEqual(t?.ttft_ms ?? 0);
		expect(t?.ttft_ms).toBeGreaterThan(0);
		expect(t?.decode_ms).toBeGreaterThan(90); // 2nd delta 120ms after 1st
		expect(t?.prefill_ms).toBeGreaterThan(0);
	});
});

test.describe("translator back-compat (W257)", () => {
	test("no startedAt → no `_server_timings` on the wire @unit", async () => {
		const up = await fetch(`${stubBase}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
		});
		const res = new Response(
			anthropicSseFromOpenAi(up.body ?? new ReadableStream(), {
				id: "msg_n",
				model: "x",
				routing: { port: 8901 },
			}),
		);
		const text = await res.text();
		expect(text).not.toContain("_server_timings");
	});
});

test.describe("buffered timings (W257)", () => {
	test("anthropicSseFromText carries pre-measured `_server_timings` @unit", async () => {
		const timings: RequestTimings = { total_ms: 42, prefill_ms: 40 };
		const res = new Response(
			anthropicSseFromText("hi", { id: "msg_b", model: "x", timings }, "stop"),
		);
		const md = parseSse(await res.text()).find((e) => e.ev === "message_delta")
			?.data as { usage: { _server_timings?: RequestTimings } };
		expect(md.usage._server_timings).toEqual({
			total_ms: 42,
			prefill_ms: 40,
		});
	});
});

// shim-level: one live router-shim on a scratch port against the stub
const shimHome = mkdtempSync(join(tmpdir(), "w257-"));
mkdirSync(join(shimHome, ".claude", "local-llm"), { recursive: true });
writeFileSync(
	join(shimHome, ".claude", "local-llm", "prefs.json"),
	JSON.stringify({ allow_cloud: false, kev: { enabled: false } }),
);
const shimPort = await (async () => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const p = s.port ?? 0;
	s.stop(true);
	return p;
})();
const shim = Bun.spawn({
	cmd: [
		process.execPath,
		new URL("../bin/router-shim.ts", import.meta.url).pathname,
	],
	env: {
		...process.env,
		HOME: shimHome,
		BELT_ROUTER_PORT: String(shimPort),
		BELT_UPSTREAM_BASE: stubBase,
		BELT_RETRY_WAIT_CAP_MS: "500",
	},
	stdout: "ignore",
	stderr: "ignore",
});
const shimBase = `http://127.0.0.1:${shimPort}`;
for (let i = 0; i < 100; i++) {
	const up = await fetch(`${shimBase}/health/liveliness`)
		.then((r) => r.ok)
		.catch(() => false);
	if (up) break;
	await Bun.sleep(50);
}
test.afterAll(() => {
	shim.kill();
	rmSync(shimHome, { recursive: true, force: true });
});

test.describe("shim `_server_timings` (W257)", () => {
	const post = (body: Record<string, unknown>) =>
		fetch(`${shimBase}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3-flash",
				max_tokens: 2048,
				...body,
			}),
		});

	test("JSON completion: `_server_timings` total + prefill @unit", async () => {
		const r = await post({
			messages: [{ role: "user", content: "Reply with the word OK." }],
		});
		expect(r.status).toBe(200);
		const j = (await r.json()) as {
			content?: Array<{ text?: string }>;
			_server_timings?: RequestTimings;
		};
		expect(j.content?.[0]?.text).toBe("pong");
		expect(j._server_timings?.prefill_ms).toBeDefined();
		expect(j._server_timings?.total_ms).toBeGreaterThanOrEqual(
			j._server_timings?.prefill_ms ?? 0,
		);
	});

	test("arithmetic lane: total only @unit", async () => {
		const r = await post({
			messages: [
				{
					role: "user",
					content: "What is 17*23? Answer with the number only.",
				},
			],
		});
		const j = (await r.json()) as { _server_timings?: RequestTimings };
		expect(j._server_timings?.total_ms).toBeDefined();
		expect(j._server_timings?.prefill_ms).toBeUndefined();
	});
});
