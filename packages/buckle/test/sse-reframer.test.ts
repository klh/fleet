// test/sse-reframer.test.ts — W616.1 regression: litellm's anthropic
// keepalive ping splices mid-data-line under write races (fleet/lane-autow499
// log, 3 lane deaths). The re-framer must re-frame cleanly, drop pings,
// quarantine corrupt events and keep the stream alive.
import { describe, expect, test } from "bun:test";
import { sseReframer } from "../src/sse.ts";

const enc = new TextEncoder();

async function run(
	chunks: string[],
	onDrop?: (reason: "ping" | "corrupt", preview: string) => void,
): Promise<string> {
	const dec = new TextDecoder();
	let out = "";
	const src = new ReadableStream<Uint8Array>({
		start(c) {
			for (const ch of chunks) c.enqueue(enc.encode(ch));
			c.close();
		},
	});
	await src.pipeThrough(sseReframer(onDrop)).pipeTo(
		new WritableStream<Uint8Array>({
			write(b) {
				out += dec.decode(b, { stream: true });
			},
		}),
	);
	return out;
}

describe("sseReframer (W616.1)", () => {
	test("well-framed stream re-emits byte-identical", async () => {
		const s =
			'event: message_start\ndata: {"type":"message_start"}\n\n' +
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n';
		expect(await run([s])).toBe(s);
	});

	test("ping frames are dropped, neighbors intact", async () => {
		const good =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n';
		const out = await run([
			good +
				'event: ping\ndata: {"type": "ping"}\n\n' +
				'data: {"type": "ping"}\n\n' +
				good,
		]);
		expect(out).toBe(good + good);
	});

	test("W499 splice shape: corrupt event quarantined, stream survives", async () => {
		const good =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":22,"delta":{"type":"text_delta","text":"b"}}\n\n';
		const drops: Array<[string, string]> = [];
		const out = await run(
			[
				// the exact W499 evidence shape: ping grafted mid-payload
				'event: content_block_delta\ndata: {"type": "content_block_delta", "indevent: ping\ndata: {"type": "ping"}\n\n',
				good,
			],
			(reason, preview) => drops.push([reason, preview]),
		);
		expect(out).toBe(good);
		expect(drops).toEqual([
			[
				"corrupt",
				'{"type": "content_block_delta", "indevent: ping\n{"type": "ping"}',
			],
		]);
	});

	test("event split across chunks re-assembles canonically", async () => {
		const frame =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n';
		const out = await run([
			frame.slice(0, 7),
			frame.slice(7, 40),
			frame.slice(40),
		]);
		expect(out).toBe(frame);
	});

	test("CRLF + byte-at-a-time feed survives", async () => {
		const frame =
			'event: ping\r\n\r\nevent: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\r\n\r\n';
		const bytes = enc.encode(frame);
		const chunks: string[] = [];
		for (const b of bytes) chunks.push(String.fromCharCode(b));
		const out = await run(chunks);
		expect(out).toBe(
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
		);
	});

	test("multibyte char split across chunks decodes intact", async () => {
		const bytes = enc.encode(
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"héllo ☃"}}\n\n',
		);
		const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte snowman
		const dec = new TextDecoder();
		let out = "";
		const src = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(bytes.slice(0, cut));
				c.enqueue(bytes.slice(cut));
				c.close();
			},
		});
		await src.pipeThrough(sseReframer()).pipeTo(
			new WritableStream<Uint8Array>({
				write(b) {
					out += dec.decode(b, { stream: true });
				},
			}),
		);
		expect(out).toContain("héllo ☃");
	});

	test("comment lines pass through, blank lines normalize", async () => {
		const out = await run([": keepalive\n\n"]);
		expect(out).toBe(": keepalive\n");
	});

	test("multi-line data joins into one canonical frame", async () => {
		const out = await run([
			'event: message_start\ndata: {"a":1,\ndata: "b":2}\n\n',
		]);
		expect(out).toBe('event: message_start\ndata: {"a":1,\n"b":2}\n\n');
	});

	test("tail event without closing blank line emits at flush", async () => {
		const out = await run([
			'event: message_stop\ndata: {"type":"message_stop"}',
		]);
		expect(out).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
	});

	test("a throwing drop observer never breaks the stream", async () => {
		const good =
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n';
		const out = await run(
			['event: ping\ndata: {"type": "ping"}\n\n', good],
			() => {
				throw new Error("observer boom");
			},
		);
		expect(out).toBe(good);
	});
});
