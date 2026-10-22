import { expect, test } from "bun:test";
import { createAdmission } from "../bin/admission.ts";
import { anthropicSseFromOpenAi, openLocalStream } from "../bin/router-core.ts";
import { primeLocalStream } from "../bin/stream-prelude.ts";

const enc = new TextEncoder();
const responseBody = (text: string) => {
	const body = new Response(text).body;
	if (!body) throw new Error("missing fixture body");
	return body;
};
const role = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
const text = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';

test("metadata then native admission error never commits a successful stream", async () => {
	const body = responseBody(
		role +
			'data: {"error":{"type":"overloaded_error","code":"local_busy","message":"capacity reached"}}\n\ndata: [DONE]\n\n',
	);
	const result = await primeLocalStream(body, new AbortController().signal);
	expect(result).toMatchObject({
		ok: false,
		error: "local_busy: capacity reached",
	});
});

test("EOF after metadata remains a typed empty refusal", async () => {
	const result = await primeLocalStream(
		responseBody(role),
		new AbortController().signal,
	);
	expect(result).toMatchObject({
		ok: false,
		status: 502,
		error: "empty_response",
	});
});

test("actual HTTP 200 backend overload after metadata records a failed local attempt", async () => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch() {
			return new Response(
				`${role}data: {"error":{"type":"overloaded_error","message":"native backend busy"}}\n\ndata: [DONE]\n\n`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	try {
		const attempts: unknown[] = [];
		const result = await openLocalStream(
			{ port: 8901, model: "fixture" },
			[],
			8,
			0,
			{
				base: `http://127.0.0.1:${server.port}`,
				onAttempt: (attempt) => attempts.push(attempt),
			},
		);
		expect(result).toMatchObject({
			ok: false,
			status: 503,
			error: "overloaded_error: native backend busy",
		});
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({ status: 503, failureKind: "http" });
	} finally {
		server.stop(true);
	}
});

test("valid split prelude bytes replay exactly once", async () => {
	const raw = `${role}${text}data: [DONE]\n\n`;
	const result = await primeLocalStream(
		responseBody(raw),
		new AbortController().signal,
	);
	expect(result.ok).toBe(true);
	if (result.ok) expect(await new Response(result.body).text()).toBe(raw);
});

test("EOF flush preserves usable unterminated final frame", async () => {
	const raw = 'data: {"choices":[{"delta":{"content":"last"}}]}';
	const result = await primeLocalStream(
		responseBody(raw),
		new AbortController().signal,
	);
	expect(result.ok).toBe(true);
	if (result.ok) expect(await new Response(result.body).text()).toBe(raw);
});

test("deadline returns while never-settling transport cancellation retains admission", async () => {
	const admission = createAdmission(1);
	const release = admission.tryAcquire(1234);
	if (!release) throw new Error("missing fixture lease");
	let cleanup: Promise<void> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(enc.encode(role));
		},
		cancel: () => new Promise<void>(() => {}),
	});
	const before = Date.now();
	await expect(
		primeLocalStream(body, AbortSignal.timeout(20), (pending) => {
			cleanup = pending;
			void pending.then(release);
		}),
	).rejects.toThrow();
	expect(Date.now() - before).toBeLessThan(200);
	expect(cleanup).toBeDefined();
	expect(admission.tryAcquire(1234)).toBeNull();
});

test("original deadline cancels stalled metadata and bounded prelude refuses overflow", async () => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(enc.encode(role));
		},
		cancel() {
			cancelled = true;
		},
	});
	await expect(
		primeLocalStream(stream, AbortSignal.timeout(20)),
	).rejects.toThrow();
	expect(cancelled).toBe(true);
	await expect(
		primeLocalStream(
			responseBody(":".repeat(65_537)),
			new AbortController().signal,
		),
	).rejects.toThrow("prelude_limit");
});

test("two held backend streams retain existing admission slots through cancel cleanup", async () => {
	const admission = createAdmission(2);
	let active = 0;
	let releaseCleanup!: () => void;
	const cleanup = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	const open = async () => {
		const release = admission.tryAcquire(1234);
		if (!release) return null;
		active++;
		expect(active).toBeLessThanOrEqual(2);
		const result = await primeLocalStream(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(enc.encode(role + text));
				},
				async cancel() {
					await cleanup;
					active--;
				},
			}),
			new AbortController().signal,
		);
		return result.ok
			? anthropicSseFromOpenAi(
					result.body,
					{ id: "test", model: "fixture", routing: {} },
					release,
				)
			: null;
	};
	const [a, b] = await Promise.all([open(), open()]);
	expect(await open()).toBeNull();
	if (!a || !b) throw new Error("held streams missing");
	const cancelled = a.cancel();
	expect(admission.inflight(1234)).toBe(2);
	releaseCleanup();
	await cancelled;
	expect(admission.inflight(1234)).toBe(1);
	await b.cancel();
	expect(active).toBe(0);
});
