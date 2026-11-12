import { TransportObservation } from "@klh/telemetry/src/transport-evidence.ts";
import { poolOfUrl, serveStub, sseHeaders } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import { SSE_KEEPALIVE, SseSniffer } from "../src/sse.ts";
import {
	type HeartbeatClock,
	withSseHeartbeats,
} from "../src/sse-heartbeat.ts";
import { defaultFetch } from "../src/wire.ts";
import { testDeps } from "./deps.ts";

function manualClock() {
	let now = 0,
		id = 0;
	const jobs = new Map<number, { at: number; callback: () => void }>();
	const clock: HeartbeatClock = {
		now: () => now,
		schedule: (callback, delay) => {
			const key = ++id;
			jobs.set(key, { at: now + delay, callback });
			return () => {
				jobs.delete(key);
			};
		},
	};
	return {
		clock,
		pending: () => jobs.size,
		advance: (ms: number) => {
			const end = now + ms;
			for (;;) {
				const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				now = next[1].at;
				jobs.delete(next[0]);
				next[1].callback();
			}
			now = end;
		},
	};
}
async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
test.describe("@unit quiet SSE heartbeat", () => {
	test("an established quiet stream sends a comment at25s without model progress", async () => {
		const time = manualClock();
		let cancelled = 0;
		const source = new ReadableStream<Uint8Array>({
				cancel() {
					cancelled++;
				},
			}),
			reader = withSseHeartbeats(source, undefined, time.clock).getReader();
		let received: string | null = null;
		const pending = reader.read().then((r) => {
			received = r.value ? new TextDecoder().decode(r.value) : null;
		});
		try {
			await flush();
			time.advance(24999);
			await flush();
			expect(received).toBeNull();
			time.advance(1);
			await flush();
			expect(received).toBe(SSE_KEEPALIVE);
			const sniffer = new SseSniffer("openai");
			sniffer.push(received ?? "");
			expect(sniffer.framesSeen()).toBe(0);
			expect(sniffer.usage()).toBeNull();
			expect(sniffer.completed()).toBe(false);
		} finally {
			await reader.cancel();
			await pending;
		}
		expect(cancelled).toBe(1);
		expect(time.pending()).toBe(0);
	});
});

test.describe("@unit SSE heartbeat lifetime and backpressure", () => {
	test("EOF and source errors clear the clock and preserve the original cause", async () => {
		const time = manualClock(),
			frame = new TextEncoder().encode("data: [DONE]\n\n");
		const source = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(frame);
					c.close();
				},
			}),
			reader = withSseHeartbeats(source, undefined, time.clock).getReader();
		expect((await reader.read()).value).toEqual(frame);
		expect((await reader.read()).done).toBe(true);
		expect(time.pending()).toBe(0);
		time.advance(900000);
		expect(time.pending()).toBe(0);
		const failure = Error("upstream idle deadline");
		const bad = new ReadableStream<Uint8Array>({
				start(c) {
					c.error(failure);
				},
			}),
			badReader = withSseHeartbeats(bad, undefined, time.clock).getReader();
		await expect(badReader.read()).rejects.toBe(failure);
		expect(time.pending()).toBe(0);
	});
	test("abort and downstream cancel clear timers even when source cancellation never settles", async () => {
		for (const abortBySignal of [false, true]) {
			const time = manualClock(),
				ac = new AbortController();
			let cancelled = 0;
			const source = new ReadableStream<Uint8Array>({
					cancel() {
						cancelled++;
						return new Promise(() => {});
					},
				}),
				reader = withSseHeartbeats(source, ac.signal, time.clock).getReader(),
				waiting = reader.read();
			if (abortBySignal) {
				ac.abort();
				await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
			} else {
				await reader.cancel();
				expect((await waiting).done).toBe(true);
			}
			await flush();
			expect(cancelled).toBe(1);
			expect(time.pending()).toBe(0);
			time.advance(900000);
			expect(time.pending()).toBe(0);
		}
	});
	test("a stalled consumer never accumulates heartbeat frames or extra upstream reads", async () => {
		const time = manualClock();
		let pulls = 0,
			cancelled = 0;
		const source = new ReadableStream<Uint8Array>({
				pull() {
					pulls++;
					return new Promise(() => {});
				},
				cancel() {
					cancelled++;
				},
			}),
			out = withSseHeartbeats(source, undefined, time.clock);
		await flush();
		const before = pulls;
		time.advance(900000);
		await flush();
		expect(pulls).toBe(before);
		expect(time.pending()).toBe(1);
		const reader = out.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			SSE_KEEPALIVE,
		);
		let extra = false;
		const pending = reader.read().then(() => {
			extra = true;
		});
		await flush();
		expect(extra).toBe(false);
		await reader.cancel();
		await pending;
		expect(cancelled).toBe(1);
		expect(time.pending()).toBe(0);
	});
	test("partial event bytes are not split by a transport comment", async () => {
		const time = manualClock();
		let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
		const source = new ReadableStream<Uint8Array>({
				start(c) {
					ctl = c;
				},
			}),
			reader = withSseHeartbeats(source, undefined, time.clock).getReader(),
			encode = (s: string) => new TextEncoder().encode(s);
		if (!ctl) throw Error("Controlled source absent");
		ctl.enqueue(encode('data: {"content":"'));
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			'data: {"content":"',
		);
		let got: string | null = null;
		const waiting = reader.read().then((r) => {
			got = new TextDecoder().decode(r.value);
		});
		time.advance(25000);
		await flush();
		expect(got).toBeNull();
		ctl.enqueue(encode('x"}\n\n'));
		await waiting;
		expect(got).toBe('x"}\n\n');
		const comment = reader.read();
		time.advance(25000);
		expect(new TextDecoder().decode((await comment).value)).toBe(SSE_KEEPALIVE);
		await reader.cancel();
		expect(time.pending()).toBe(0);
	});
});

test.describe("@unit SSE heartbeat wire separation", () => {
	test("downstream heartbeats at two legs never renew the real upstream idle guard", async () => {
		const initial = new TextEncoder().encode(
			'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
		);
		const stub = serveStub(
				() =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(c) {
								c.enqueue(initial);
							},
						}),
						{ headers: sseHeaders },
					),
			),
			transport = new TransportObservation(),
			time = manualClock();
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await defaultFetch(
				{ group: "heartbeat-fixture", url: stub.url, dialect: "openai" },
				{
					group: "heartbeat-fixture",
					dialect: "openai",
					path: "/v1/chat/completions",
					body: { model: "heartbeat-fixture", stream: true },
					key: "",
					transport,
				},
				2000,
				{ idleMs: 500, totalMs: 5000 },
				1000,
			);
			if (!response.body) throw Error("Established source required");
			const inner = withSseHeartbeats(response.body, undefined, time.clock),
				outer = withSseHeartbeats(inner, undefined, time.clock);
			reader = outer.getReader();
			expect((await reader.read()).value).toEqual(initial);
			//35 logical25s intervals exercise transport-only activity; real wire idle is shrunk to500ms.
			for (let i = 0; i < 35; i++) {
				const pending = reader.read();
				time.advance(25000);
				await flush();
				expect(new TextDecoder().decode((await pending).value)).toBe(
					SSE_KEEPALIVE,
				);
			}
			let remaining = 0;
			const finalRead = async () => {
				for (;;) {
					const part = await reader?.read();
					if (!part || part.done) throw Error("Unexpected clean EOF");
					remaining++;
					expect(remaining).toBeLessThanOrEqual(2);
					expect(new TextDecoder().decode(part.value)).toBe(SSE_KEEPALIVE);
				}
			};
			await expect(finalRead()).rejects.toMatchObject({ kind: "timeout" });
			expect(transport.snapshot()).toMatchObject({
				timeoutPhase: "stream_idle",
				timeoutBudgetMs: 500,
				bodyChunks: 1,
			});
			expect(time.pending()).toBe(0);
		} finally {
			await reader?.cancel().catch(() => {});
			stub.close();
		}
	});
	test("upstream HTTP errors remain HTTP errors before any SSE wrapper exists", async () => {
		const stub = serveStub(() =>
				Response.json(
					{ error: { message: "fixture upstream refusal" } },
					{ status: 400 },
				),
			),
			deps = testDeps(
				poolOfUrl(stub.url, { group: "heartbeat-fixture", dialect: "openai" }),
				{ policy: { num_retries: 0 } },
			);
		try {
			const response = await createApp(deps).fetch(
				new Request(`${stub.url}/v1/chat/completions`, {
					method: "POST",
					body: JSON.stringify({ model: "heartbeat-fixture", stream: true }),
				}),
			);
			expect(response.status).toBe(502);
			expect(response.headers.get("content-type")).toContain(
				"application/problem+json",
			);
			const problem = await response.json();
			expect(problem).toMatchObject({ status: 502, code: "no_route" });
			expect(problem.detail).toContain("(400)");
			expect(
				stub.requests.filter((r) => r.path === "/v1/chat/completions"),
			).toHaveLength(1);
		} finally {
			stub.close();
			deps.ledger.close();
			deps.aids.close();
		}
	});
	test("quiet pre-header attempts retain the real first-header deadline rather than an early200", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
				release = r;
			}),
			stub = serveStub(async () => {
				await gate;
				return new Response("data: [DONE]\n\n", { headers: sseHeaders });
			}),
			transport = new TransportObservation();
		try {
			await expect(
				defaultFetch(
					{ group: "heartbeat-fixture", url: stub.url, dialect: "openai" },
					{
						group: "heartbeat-fixture",
						dialect: "openai",
						path: "/v1/chat/completions",
						body: { model: "heartbeat-fixture", stream: true },
						key: "",
						transport,
					},
					50,
					{ idleMs: 900000, totalMs: 1000000 },
					1000,
				),
			).rejects.toBeDefined();
			expect(transport.snapshot()).toMatchObject({
				timeoutPhase: "headers",
				timeoutBudgetMs: 50,
				bodyChunks: 0,
			});
		} finally {
			release?.();
			stub.close();
		}
	});
});

test("@unit upstream EOF clears the heartbeat timer while the client is backpressured", async () => {
	const time = manualClock();
	let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
	const source = new ReadableStream<Uint8Array>({
			start(c) {
				ctl = c;
			},
		}),
		out = withSseHeartbeats(source, undefined, time.clock);
	await flush();
	time.advance(25000);
	await flush();
	if (!ctl) throw Error("Controlled source absent");
	const frame = new TextEncoder().encode("data: [DONE]\n\n");
	ctl.enqueue(frame);
	ctl.close();
	await flush();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		expect(time.pending()).toBe(0);
		reader = out.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			SSE_KEEPALIVE,
		);
		expect((await reader.read()).value).toEqual(frame);
		expect((await reader.read()).done).toBe(true);
	} finally {
		if (reader) {
			try {
				await reader.cancel();
			} finally {
				reader.releaseLock();
			}
		} else await out.cancel();
	}
});
