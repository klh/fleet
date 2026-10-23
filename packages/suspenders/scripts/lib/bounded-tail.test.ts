// scripts/lib/bounded-tail.test.ts — W1205.2: the bounded child-pipe tail
// reader keeps a flooding child bounded and never hands sanitization a
// truncated line (the line-alignment invariant behind the secret-suffix
// safety of generator diagnostics).
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { DIAGNOSTIC_TAIL_BYTES, readBoundedTail } from "./bounded-tail.ts";

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
	new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});

describe("readBoundedTail", () => {
	test("small stream passes through whole", async () => {
		const res = await readBoundedTail(
			streamOf(Buffer.from("abc\ndef\n")),
			16,
		);
		expect(res.text).toBe("abc\ndef\n");
		expect(res.dropped).toBe(0);
	});

	test("keeps the last maxBytes and line-aligns the window front", async () => {
		// last 8 bytes = "c\nddd\n" → aligned through the newline to "ddd\n"
		const res = await readBoundedTail(
			streamOf(Buffer.from("aaa\nbbb\nccc\nddd\n")),
			8,
		);
		expect(res.text).toBe("ddd\n");
		expect(res.dropped).toBe(12);
	});

	test("window never exceeds maxBytes (+line-alignment)", async () => {
		const big = Buffer.from(`x${"y".repeat(5000)}\n`.repeat(4));
		const res = await readBoundedTail(streamOf(big), 4096);
		expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(4096);
		expect(res.dropped).toBeGreaterThan(0);
	});

	test("truncated window with no newline yields empty text", async () => {
		const res = await readBoundedTail(
			streamOf(Buffer.from("zz".repeat(50))),
			16,
		);
		expect(res.text).toBe("");
		// everything was one partial line — it counts as dropped
		expect(res.dropped).toBe(100);
	});

	test("chunk boundaries do not shift the byte window", async () => {
		const payload = Buffer.from(
			[...Array(30).keys()].map((i) => `l${String(i).padStart(2, "0")}\n`).join(""),
		);
		const one = await readBoundedTail(streamOf(payload), 12);
		const split = await readBoundedTail(
			streamOf(payload.subarray(0, 17), payload.subarray(17)),
			12,
		);
		expect(one.text).toBe(split.text);
		expect(one.dropped).toBe(split.dropped);
		// last 12B = "l27\nl28\nl29\n"; the window front starts mid-stream,
		// so alignment drops l27's whole line through its newline
		expect(one.text).toBe("l28\nl29\n");
	});

	test("default cap matches the shared diagnostic constant", async () => {
		expect(DIAGNOSTIC_TAIL_BYTES).toBe(8192);
	});
});
