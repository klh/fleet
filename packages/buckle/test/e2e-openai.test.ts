// test/e2e-openai.test.ts — openai-dialect round-trips through createApp
// with a real mock upstream: byte identity + usage tee + ledger.
import { describe, expect, test } from "bun:test";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

function deps(pool: UpstreamPool): AppDeps {
	return testDeps(pool);
}

function poolOf(url: string): UpstreamPool {
	return {
		groups: () => ["glm-5.3-flash"],
		deployments: (g) => [{ group: g, url, dialect: "openai" as const }],
	};
}

const STREAM_FIXTURE =
	'data: {"id":"1","choices":[{"delta":{"content":"he"}}]}\n\n' +
	'data: {"id":"1","choices":[{"delta":{"content":"y"}}]}\n\n' +
	'data: {"id":"1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":5}}}\n\n' +
	"data: [DONE]\n\n";

describe("openai e2e", () => {
	test("non-streaming: byte-identity + usage to ledger", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "1",
				choices: [],
				usage: {
					prompt_tokens: 9,
					completion_tokens: 2,
					prompt_tokens_details: { cached_tokens: 7 },
				},
			}),
		);
		const d = deps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({ model: "glm-5.3-flash", stream: false }),
			}),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			id: string;
			usage: { prompt_tokens: number };
		};
		expect(out.id).toBe("1");
		expect(out.usage.prompt_tokens).toBe(9);
		expect(upstream.calls[0]?.path).toBe("/v1/chat/completions");
		const sent = upstream.calls[0]?.body as { model?: string } | undefined;
		expect(sent?.model).toBe("glm-5.3-flash");
		// W457: cached_tokens surfaces on the aggregate + per-request audit row
		const row = d.ledger.rows()[0] ?? {};
		expect(row.cache_r).toBe(7);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.cache_r).toBe(7);
		// openai usage has no creation field → known zero, not NULL (NULL =
		// unobserved usage; see auditUsage)
		expect(audit.cache_c).toBe(0);
		upstream.close();
	});

	test("streaming: tee is byte-identical + usage lands in the ledger", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(STREAM_FIXTURE, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const d = deps(poolOf(upstream.url));
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/chat/completions`, {
				method: "POST",
				body: JSON.stringify({ model: "glm-5.3-flash", stream: true }),
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const text = await res.text();
		expect(text).toBe(STREAM_FIXTURE); // byte identity
		await Bun.sleep(20); // let the tee branch settle
		const row = d.ledger.rows()[0] ?? {};
		expect(row.in_tok).toBe(9);
		expect(row.out_tok).toBe(2);
		expect(row.requests).toBe(1);
		// W457: the stream's terminal usage chunk feeds the audit row too
		expect(row.cache_r).toBe(5);
		const audit = d.ledger.auditRows()[0] ?? {};
		expect(audit.cache_r).toBe(5);
		upstream.close();
	});
});
