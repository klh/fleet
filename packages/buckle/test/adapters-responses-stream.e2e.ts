// test/adapters-responses-stream.e2e.ts — W2583: streaming over the
// Responses-wire adapter family. A responses SSE stream re-frames to openai
// chat chunk SSE (finish + include_usage chunk + [DONE]) for chat clients,
// and composes through the W426 mirror to anthropic SSE for anthropic
// clients. Usage lands in the ledger from the translated usage chunk.
import { expect, test } from "@playwright/test";
import { createApp } from "../src/handlers.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

test.describe("@api", () => {
	const GROUP = "gpt-6-sol";

	const depOf = (url: string): Deployment => ({
		group: GROUP,
		url,
		dialect: "openai",
		adapter: "openai-responses",
	});

	const poolOf = (url: string): UpstreamPool => ({
		groups: () => [GROUP],
		deployments: (g) => (g === GROUP ? [depOf(url)] : []),
	});

	const STREAM_FIXTURE = `${[
		'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9","model":"gpt-6-sol","usage":null}}',
		'data: {"type":"response.output_text.delta","delta":"he"}',
		'data: {"type":"response.output_text.delta","delta":"y"}',
		'data: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
	].join("\n\n")}\n\n`;

	const streamUpstream = async () =>
		await startMockUpstream(
			() =>
				new Response(STREAM_FIXTURE, {
					headers: { "content-type": "text/event-stream" },
				}),
		);

	/** The re-framed chat chunk stream asserts: content "hey", finish stop,
	 *  usage 1/2, [DONE] terminal. */

	/** Ledger banking lands async after the pipes settle — wait for it. */
	const waitForLedger = async (
		d: ReturnType<typeof testDeps>,
	): Promise<Record<string, unknown>> => {
		let row: Record<string, unknown> = {};
		for (let i = 0; i < 50 && row.in_tok === undefined; i++) {
			row = (d.ledger.rows()[0] ?? {}) as Record<string, unknown>;
			if (row.in_tok === undefined) await new Promise((r) => setTimeout(r, 20));
		}
		return row;
	};
	const expectChatFrames = async (res: Response): Promise<void> => {
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		const frames = text
			.split("\n\n")
			.filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
			.map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);
		const contents = frames
			.map((f) => (f.choices as Array<Record<string, unknown>>)[0])
			.filter((c) => c !== undefined)
			.map((c) => (c.delta as Record<string, unknown> | undefined)?.content)
			.filter((t) => typeof t === "string");
		expect(contents.join("")).toBe("hey");
		const finishReason = (chunk: Record<string, unknown> | undefined) =>
			(chunk?.choices as Array<Record<string, unknown>> | undefined)?.[0]
				?.finish_reason;
		const finish = frames.find((f) => finishReason(f) != null);
		expect(finishReason(finish)).toBe("stop");
		const usage = frames.find((f) => f.usage !== undefined)?.usage as
			| Record<string, number>
			| undefined;
		expect(usage?.prompt_tokens).toBe(1);
		expect(usage?.completion_tokens).toBe(2);
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
	};

	test("chat client stream:true: responses SSE re-frames to chat chunks + [DONE]", async () => {
		const upstream = await streamUpstream();
		const d = testDeps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			}),
		);
		expect(res.status).toBe(200);
		expect(upstream.calls[0]?.path).toBe("/v1/responses");
		const sent = upstream.calls[0]?.body as Record<string, unknown>;
		expect(sent.stream).toBe(true);
		expect(sent.stream_options).toBeUndefined();
		await expectChatFrames(res);
		const row = await waitForLedger(d);
		expect(row.in_tok).toBe(1);
		expect(row.out_tok).toBe(2);
		upstream.close();
	});

	test("anthropic client stream:true: composes through to anthropic SSE", async () => {
		const upstream = await streamUpstream();
		const d = testDeps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify({
					model: GROUP,
					max_tokens: 64,
					messages: [{ role: "user", content: "hi" }],
					stream: true,
				}),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(upstream.calls[0]?.path).toBe("/v1/responses");
		const text = await res.text();
		expect(text).toContain("message_start");
		expect(text).toContain("content_block_delta");
		expect(text).toContain("text_delta");
		expect(text).toContain("message_stop");
		const deltas = [...text.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]);
		expect(deltas.join("")).toBe("hey");
		expect(text).toContain('"input_tokens":1');
		const row = await waitForLedger(d);
		expect(row.in_tok).toBe(1);
		expect(row.out_tok).toBe(2);
		upstream.close();
	});
});
