import { expect, test } from "@playwright/test";
import { drainTerminalFrame } from "../src/drain.ts";
import { traceStreamErrorPayload } from "../src/error-trace.ts";
import { sseReframer } from "../src/sse.ts";

const TRACE_ID = "a".repeat(32);

async function reframe(
	frame: string,
	dialect: "anthropic" | "openai",
	upstream: Response,
	hub: string,
): Promise<string> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(frame));
			controller.close();
		},
	});
	const out = source.pipeThrough(
		sseReframer(undefined, dialect, undefined, (payload) =>
			traceStreamErrorPayload(
				payload,
				upstream,
				TRACE_ID,
				hub,
				"rid-1",
				"provider-1",
			),
		),
	);
	return new Response(out).text();
}

test.describe("remaining Buckle error boundaries @api", () => {
	test("Anthropic provider SSE error identifies the originating hub and relay", async () => {
		const frame =
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n';
		const provider = new Response(null, { status: 200 });
		const first = await reframe(frame, "anthropic", provider, "hub-a");
		const peer = new Response(null, {
			status: 200,
			headers: { "x-klh-service": "buckle", "x-klh-trace-id": TRACE_ID },
		});
		const second = await reframe(first, "anthropic", peer, "hub-b");
		const body = JSON.parse(
			second.split("data: ")[1]?.split("\n")[0] ?? "",
		) as {
			type: string;
			error: { type: string; message: string; trace_id: string };
			fleet_trace: { id: string; hops: { hub: string; target: string }[] };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("overloaded_error");
		expect(body.error.message).toContain(`trace=${TRACE_ID}`);
		expect(body.error.trace_id).toBe(TRACE_ID);
		expect(body.fleet_trace.id).toBe(TRACE_ID);
		expect(body.fleet_trace.hops.map((h) => h.hub)).toEqual(["hub-a", "hub-b"]);
		expect(body.fleet_trace.hops[0]?.target).toBe("provider-1");
	});

	test("OpenAI failed SSE event keeps its wire shape and gets a trace", async () => {
		const frame =
			'data: {"type":"response.failed","response":{"error":{"code":"rate_limit","message":"busy"}}}\n\n';
		const out = await reframe(frame, "openai", new Response(null), "hub-c");
		const body = JSON.parse(out.split("data: ")[1]?.split("\n")[0] ?? "") as {
			type: string;
			response: { error: { code: string; trace_id: string } };
			fleet_trace: { hops: { code: string }[] };
		};
		expect(body.type).toBe("response.failed");
		expect(body.response.error.code).toBe("rate_limit");
		expect(body.response.error.trace_id).toBe(TRACE_ID);
		expect(body.fleet_trace.hops[0]?.code).toBe("rate_limit");
	});

	test("planned drain terminal includes the same trace in both dialects", () => {
		for (const dialect of ["anthropic", "openai"] as const) {
			const frame = drainTerminalFrame(dialect, "rid-2", {
				id: TRACE_ID,
				hub: "hub-d",
			});
			const body = JSON.parse(
				frame.split("data: ")[1]?.split("\n")[0] ?? "",
			) as {
				error: { code: string; message: string; trace_id: string };
				fleet_trace: { hops: { hub: string }[] };
			};
			expect(body.error.code).toBe("gateway_restarting");
			expect(body.error.message).toContain(`trace=${TRACE_ID}`);
			expect(body.error.trace_id).toBe(TRACE_ID);
			expect(body.fleet_trace.hops[0]?.hub).toBe("hub-d");
		}
	});

	test("Bun body-cap 413 occurs before fetch and error handlers", async () => {
		let fetched = 0;
		let errored = 0;
		const server = Bun.serve({
			port: 0,
			maxRequestBodySize: 16,
			fetch() {
				fetched++;
				return new Response("handled");
			},
			error() {
				errored++;
				return new Response("caught");
			},
		});
		try {
			const res = await fetch(server.url, {
				method: "POST",
				body: "x".repeat(100),
			});
			expect(res.status).toBe(413);
			expect(fetched).toBe(0);
			expect(errored).toBe(0);
			expect(res.headers.get("x-klh-trace-id")).toBeNull();
		} finally {
			server.stop(true);
		}
	});
});
