// W2178: ported from the W1118 branch's gov-slot-lease.test.ts to
// @playwright/test (@api), riding the shared gate kit (test/gate.ts).
// test/gov-slot-lease — W1118 #55606 acceptance at the wire: a quiet SSE
// stream (zero chunks past leaseMs) holds its admission slot via the
// deadline heartbeat, and a real client abort (socket drop) releases the
// slot immediately. Real Bun.serve on a scratch port, 50ms lease so the
// sweep windows are deterministic.
import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import { Slots } from "../src/gov/slots.ts";
import { issueViaAdmin, startGate } from "./gate.ts";
import { startMockUpstream } from "./mock.ts";

test.describe({ tag: "@api" }, () => {
	const SLOTS = { global: 1, perTeam: 0 };

	async function issueKey(base: string): Promise<string> {
		const out = await issueViaAdmin(base, {
			name: "lease",
			scopes: ["buckle:proxy:WRITE_"],
		});
		return out.key;
	}

	function chatStream(
		base: string,
		key: string,
		signal?: AbortSignal,
	): Promise<Response> {
		return fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: JSON.stringify({ model: "glm-5.3-flash", stream: true }),
			signal,
		});
	}

	test("W1118: a quiet SSE stream holds its slot past leaseMs; settle frees it", async () => {
		let releaseFirst: () => void = () => {};
		let firstInferenceStarted = false;
		const firstDone = new Promise<void>((r) => {
			releaseFirst = r;
		});
		// the gate preflights /v1/models BEFORE the first inference; only the
		// FIRST CHAT INFERENCE is held — zero chunks across many lease windows
		const upstream = await startMockUpstream(async (req) => {
			const chatInference =
				new URL(req.url).pathname === "/v1/chat/completions";
			if (chatInference && !firstInferenceStarted) {
				firstInferenceStarted = true;
				await firstDone;
			}
			return new Response("data: [DONE]\n\n", {
				headers: { "content-type": "text/event-stream" },
			});
		});
		const gate = await startGate({
			upstreamUrl: upstream.url,
			slots: SLOTS,
			slotLeaseMs: 50,
		});
		const key = await issueKey(gate.base);
		const first = chatStream(gate.base, key);
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
		// drained to settle; HEAD's empty-response guard owns the body text
		await firstResp.text();
		await Bun.sleep(50); // settle — the lease releases at stream end
		const third = await chatStream(gate.base, key);
		expect(third.status).toBe(200);
		gate.stop();
		upstream.close();
	});

	test("W1118: a real client abort releases the slot (socket drop)", async () => {
		let releaseFirst: () => void = () => {};
		let firstInferenceStarted = false;
		const firstDone = new Promise<void>((r) => {
			releaseFirst = r;
		});
		const upstream = await startMockUpstream(async (req) => {
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
		const gate = await startGate({
			upstreamUrl: upstream.url,
			slots: SLOTS,
			slotLeaseMs: 50,
		});
		const key = await issueKey(gate.base);
		const ac = new AbortController();
		const aborted = chatStream(gate.base, key, ac.signal);
		aborted.catch(() => {}); // the abort rejection is expected — drained below
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

	test("W1118 #57099: a DB fault under the lease logs and survives", async () => {
		// acquire a real lease, then kill the DB under a live heartbeat
		// cadence: the touch must log observably, never throw out of the timer
		const db = new Database(":memory:");
		db.exec(
			"CREATE TABLE admission_slot_holders (scope TEXT NOT NULL, holder TEXT NOT NULL, touched INTEGER NOT NULL, PRIMARY KEY (scope, holder)); CREATE INDEX admission_slot_holders_touched ON admission_slot_holders (touched);",
		);
		const slots = new Slots(db, SLOTS, Date.now, 120_000);
		const lease = slots.acquire(null);
		if (lease === null) {
			throw new Error("acquire must succeed against an empty pool");
		}
		const errors: string[] = [];
		const orig = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			db.close();
			lease.renew(); // the same fault class via the renew face
			const hb = setInterval(() => lease.hold(120_000), 5);
			await Bun.sleep(30);
			clearInterval(hb);
		} finally {
			console.error = orig;
		}
		expect(errors.some((m) => m.includes("slot touch failed (holder="))).toBe(
			true,
		);
		lease.release(); // the settle face stays no-throw after the fault
	});
});
