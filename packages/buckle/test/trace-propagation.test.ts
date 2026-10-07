// test/trace-propagation.test.ts — W461 stage 1 end-to-end: traceparent
// propagation from the client leg through the router's attempt loop to the
// upstream wire, across adapters and bridged hops. Correlation only —
// baggage never rides the upstream leg.
import { describe, expect, test } from "bun:test";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const INBOUND =
	"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function deps(
	url: string,
	numRetries = 0,
): AppDeps {
	return testDeps(
		{
			groups: () => ["glm-5.3-flash"],
			deployments: (g) => [{ group: g, url, dialect: "openai" as const }],
		} satisfies UpstreamPool,
		{ policy: { num_retries: numRetries, allowed_fails: 99, cooldown_time: 30 } },
	);
}

const POST = (url: string, headers?: Record<string, string>): Request =>
	new Request(`${url}/v1/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
	});

describe("traceparent propagation (W461 stage 1)", () => {
	test("inbound traceparent → upstream child: same trace id, fresh span id", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "1", choices: [] }),
		);
		const app = createApp(deps(upstream.url));
		const res = await app.fetch(
			POST(upstream.url, { traceparent: INBOUND, baggage: "fleet.lane.id=autow461,secret=x" }),
		);
		expect(res.status).toBe(200);
		const seen = upstream.calls[0]?.headers.get("traceparent") ?? "";
		const parts = seen.split("-");
		expect(parts[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(parts[2]).not.toBe("00f067aa0ba902b7");
		expect(parts).toHaveLength(4);
		// baggage never rides the external-provider leg
		expect(upstream.calls[0]?.headers.get("baggage")).toBe(null);
		upstream.close();
	});

	test("no inbound traceparent → valid root trace on the wire", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "1", choices: [] }),
		);
		const app = createApp(deps(upstream.url));
		await app.fetch(POST(upstream.url));
		const seen = upstream.calls[0]?.headers.get("traceparent") ?? "";
		expect(seen).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
		const [ver, trace, span] = seen.split("-");
		expect(ver).toBe("00");
		expect(trace).not.toMatch(/^0+$/);
		expect(span).not.toMatch(/^0+$/);
		upstream.close();
	});

	test("malformed inbound traceparent is never propagated", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "1", choices: [] }),
		);
		const app = createApp(deps(upstream.url));
		await app.fetch(POST(upstream.url, { traceparent: "garbage-trace" }));
		const seen = upstream.calls[0]?.headers.get("traceparent") ?? "";
		expect(seen).not.toBe("garbage-trace");
		expect(seen).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/);
		upstream.close();
	});

	test("retry ordinals distinct: same trace id, different span id per attempt", async () => {
		const upstream = await startMockUpstream((_req, _body, n) =>
			n === 1
				? Response.json({ e: 1 }, { status: 500 })
				: Response.json({ id: "1", choices: [] }),
		);
		const app = createApp(deps(upstream.url, 1));
		const res = await app.fetch(
			POST(upstream.url, { traceparent: INBOUND }),
		);
		expect(res.status).toBe(200);
		expect(upstream.calls).toHaveLength(2);
		const [a, b] = upstream.calls.map((c) =>
			(c.headers.get("traceparent") ?? "").split("-"),
		);
		expect(a?.[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(b?.[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		expect(a?.[2]).not.toBe(b?.[2]);
		upstream.close();
	});

	test("bridged hop (openai client → anthropic upstream) carries the child trace", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				model: "m",
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		const app = createApp(
			testDeps(
				{
					groups: () => ["glm-5.3-flash"],
					deployments: (g) => [
						{ group: g, url: upstream.url, dialect: "anthropic" as const },
					],
				} satisfies UpstreamPool,
			),
		);
		const res = await app.fetch(
			POST(upstream.url, { traceparent: INBOUND }),
		);
		expect(res.status).toBe(200);
		const seen = upstream.calls[0]?.headers.get("traceparent") ?? "";
		expect(seen.split("-")[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
		upstream.close();
	});
});
