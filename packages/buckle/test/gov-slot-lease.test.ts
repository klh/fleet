// test/gov-slot-lease.test.ts — W1118 #55606 acceptance at the wire: a
// quiet SSE stream (zero chunks past leaseMs) holds its admission slot via
// the deadline heartbeat, and a real client abort (socket drop) releases
// the slot immediately. Real Bun.serve on a scratch port, 50ms lease so
// the sweep windows are deterministic.
import { describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";
import { startMockUpstream } from "./mock.ts";

const ROOT = "buckle-test-root";

interface GateServer {
	base: string;
	stop(): void;
}

async function startGate(
	upstreamUrl: string,
	slots: { global: number; perTeam: number },
	slotLeaseMs: number,
): Promise<GateServer> {
	const dir = `/tmp/buckle-lease-${Date.now()}-${process.pid}-${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	const cfg = `groups:\n  glm-5.3-flash:\n    - url: ${upstreamUrl}\n      dialect: openai\n`;
	await Bun.write(`${dir}.yaml`, cfg);
	const server = startServer({
		port: 0,
		upstreamsPath: `${dir}.yaml`,
		dbPath: ":memory:",
		auth: { rootKey: ROOT, slots },
		slotLeaseMs,
	});
	return {
		base: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

async function issueKey(base: string): Promise<string> {
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({ name: "lease", scopes: ["buckle:proxy:WRITE_"] }),
	});
	const out = (await res.json()) as { key: string };
	return out.key;
}

const chatStream = (
	base: string,
	key: string,
	signal?: AbortSignal,
): Promise<Response> =>
	fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: `Bearer ${key}` },
		body: JSON.stringify({ model: "glm-5.3-flash", stream: true }),
		signal,
	});

describe("gate: W1118 slot lease across quiet streams and aborts", () => {
	test("a quiet SSE stream holds its slot past leaseMs; settle frees it", async () => {
		let releaseFirst!: () => void;
		let firstInferenceStarted = false;
		const firstDone = new Promise<void>((r) => {
			releaseFirst = r;
		});
		// test releases it — zero chunks across many lease windows
		const upstream = await startMockUpstream(async (req, _body, n) => {
			// the gate preflights /v1/models BEFORE the first inference (n=1);
			// only the FIRST CHAT INFERENCE (n=2) is held for the lease proof
			const chatInference =
				new URL(req.url).pathname === "/v1/chat/completions";
			if (chatInference && !firstInferenceStarted) {
				firstInferenceStarted = true;
				await firstDone;
			}
			void n;
			return new Response("data: [DONE]\n\n", {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const gate = await startGate(upstream.url, { global: 1, perTeam: 0 }, 50);
		const key = await issueKey(gate.base);
		const first = chatStream(gate.base, key);
		// hold starts when the FIRST INFERENCE reaches the mock, not the probe
		while (!firstInferenceStarted) await Bun.sleep(5);
		// 4x the 50ms lease with ZERO chunks — the heartbeat must hold it
		await Bun.sleep(200);
		const second = await chatStream(gate.base, key);
		expect(second.status).toBe(429);
		expect(((await second.json()) as { code: string }).code).toBe(
			"buckle.slot_exhausted",
		);
		releaseFirst();
		const firstResp = await first;
		expect(firstResp.status).toBe(200);
		expect(await firstResp.text()).toBe("data: [DONE]\n\n");
		await Bun.sleep(50); // settle — the lease releases at stream end
		const third = await chatStream(gate.base, key);
		expect(third.status).toBe(200);
		gate.stop();
		upstream.close();
	});

	test("a real client abort releases the slot (socket drop)", async () => {
		let releaseFirst!: () => void;
		let firstInferenceStarted = false;
		const firstDone = new Promise<void>((r) => {
			releaseFirst = r;
		});
		const upstream = await startMockUpstream(async (req, _body, _n) => {
			// the gate preflights /v1/models BEFORE the first inference; only
			// the FIRST CHAT INFERENCE is held so the abort lands mid-stream
			const chatInference =
				new URL(req.url).pathname === "/v1/chat/completions";
			if (chatInference && !firstInferenceStarted) {
				firstInferenceStarted = true;
				await firstDone;
			}
			return new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new TextEncoder().encode("data: x\n\n"));
						// never closes — the abort must be the settle path
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const gate = await startGate(upstream.url, { global: 1, perTeam: 0 }, 50);
		const key = await issueKey(gate.base);
		const ac = new AbortController();
		const aborted = chatStream(gate.base, key, ac.signal);
		aborted.catch(() => {}); // the abort rejection is expected — drained below
		// hold starts when the FIRST INFERENCE reaches the mock, not the probe
		while (!firstInferenceStarted) await Bun.sleep(5);
		await Bun.sleep(60); // headers through, stream live
		ac.abort(); // the socket drops mid-stream
		await Bun.sleep(100); // the gate must release the lease now
		releaseFirst();
		const after = await chatStream(gate.base, key);
		expect(after.status).toBe(200); // the abort freed the slot
		await aborted.then((r) => r.arrayBuffer()).catch(() => {});
		gate.stop();
		upstream.close();
	});
});
