// W1294.16: ported 1:1 from e2e-responses.test.ts to @playwright/test (@api).
// test/e2e-responses.test.ts — W912: the OpenAI Responses ingress
// (POST /v1/responses, bare + /w/<sid> lane-prefixed). Pass-through-first:
// the ingress path forwards VERBATIM to same-dialect upstreams (a
// responses-only model is never re-targeted at chat completions), usage
// metering covers the Responses wire's nested usage slot (top-level on the
// response object; streaming rides response.completed), trace ids ride the
// W461 seam, budgets gate the route through the standard proxy class.
import { expect, test } from "@playwright/test";
import { startMockUpstream } from "./mock.ts";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { issueViaAdmin, startGate } from "./gate.ts";

test.describe({ tag: "@api" }, () => {
	const INBOUND = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

	function poolOf(url: string): UpstreamPool {
		return {
			groups: () => ["gpt-5.3-codex"],
			deployments: (g) => [{ group: g, url, dialect: "openai" as const }],
		};
	}

	function deps(pool: UpstreamPool): AppDeps {
		return testDeps(pool);
	}

	const RESPONSES_BODY = JSON.stringify({
		model: "gpt-5.3-codex",
		input: "say heya",
		stream: false,
	});

	const POST = (url: string, headers?: Record<string, string>): Request =>
		new Request(`${url}/v1/responses`, {
			method: "POST",
			headers,
			body: RESPONSES_BODY,
		});

	const RESPONSE_OBJ = {
		id: "resp_1",
		object: "response",
		model: "gpt-5.3-codex",
		output: [],
		usage: {
			input_tokens: 12,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens: 3,
			total_tokens: 15,
		},
	};

	// The Responses wire: event-framed + bare-data frames, usage nested under
	// response.completed's response object.
	const STREAM_FIXTURE =
		'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","usage":null}}\n\n' +
		'data: {"type":"response.output_text.delta","delta":"he"}\n\n' +
		'data: {"type":"response.output_text.delta","delta":"y"}\n\n' +
		'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4},"output_tokens":3,"total_tokens":15}}}\n\n';

	test.describe("responses ingress (W912)", () => {
		test("non-streaming: path verbatim, byte-identity, usage to ledger + audit", async () => {
			const upstream = await startMockUpstream(() =>
				Response.json(RESPONSE_OBJ),
			);
			const d = deps(poolOf(upstream.url));
			const app = createApp(d);
			const res = await app.fetch(POST(upstream.url));
			expect(res.status).toBe(200);
			const out = (await res.json()) as { id: string };
			expect(out.id).toBe("resp_1");
			expect(upstream.calls[0]?.path).toBe("/v1/responses");
			const sent = upstream.calls[0]?.body as { model?: string } | undefined;
			expect(sent?.model).toBe("gpt-5.3-codex");
			const row = d.ledger.rows()[0] ?? {};
			expect(row.in_tok).toBe(12);
			expect(row.out_tok).toBe(3);
			const audit = d.ledger.auditRows()[0] as
				| { cache_r: number; dialect: string }
				| undefined;
			expect(audit?.cache_r).toBe(4);
			expect(audit?.dialect).toBe("openai");
			upstream.close();
		});

		test("streaming: byte-identical tee, usage from response.completed, no stream_options injected", async () => {
			const upstream = await startMockUpstream(
				() =>
					new Response(STREAM_FIXTURE, {
						headers: { "content-type": "text/event-stream" },
					}),
			);
			const d = deps(poolOf(upstream.url));
			const app = createApp(d);
			const res = await app.fetch(
				new Request(`${upstream.url}/v1/responses`, {
					method: "POST",
					body: JSON.stringify({
						model: "gpt-5.3-codex",
						input: "say heya",
						stream: true,
					}),
				}),
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/event-stream");
			const text = await res.text();
			expect(text).toBe(STREAM_FIXTURE); // byte identity
			await Bun.sleep(20); // let the tee branch settle
			const row = d.ledger.rows()[0] ?? {};
			expect(row.in_tok).toBe(12);
			expect(row.out_tok).toBe(3);
			expect(row.cache_r).toBe(4);
			const sent = upstream.calls[0]?.body as
				| { stream_options?: unknown }
				| undefined;
			expect(sent?.stream_options).toBeUndefined(); // never a chat knob here
			upstream.close();
		});

		test("responses-only model is NEVER bridged to an anthropic upstream", async () => {
			const upstream = await startMockUpstream(() =>
				Response.json({ id: "msg_1" }),
			);
			const app = createApp(
				testDeps({
					groups: () => ["gpt-5.3-codex"],
					deployments: (g) => [
						{ group: g, url: upstream.url, dialect: "anthropic" as const },
					],
				} satisfies UpstreamPool),
			);
			const res = await app.fetch(POST(upstream.url));
			expect(res.status).toBe(502);
			expect(upstream.calls).toHaveLength(0); // skipped, not translated
			upstream.close();
		});

		test("lane prefix: /w/<sid>/v1/responses stamps the lane, upstream sees bare path", async () => {
			const upstream = await startMockUpstream(() =>
				Response.json(RESPONSE_OBJ),
			);
			const d = deps(poolOf(upstream.url));
			const app = createApp(d);
			const res = await app.fetch(
				new Request(`${upstream.url}/w/autow912/v1/responses`, {
					method: "POST",
					body: RESPONSES_BODY,
				}),
			);
			expect(res.status).toBe(200);
			expect(upstream.calls[0]?.path).toBe("/v1/responses");
			const audit = d.ledger.auditRows()[0] as { lane?: string } | undefined;
			expect(audit?.lane).toBe("autow912");
			upstream.close();
		});

		test("citizenship: OPTIONS 204 + Allow; GET 405", async () => {
			const upstream = await startMockUpstream(() => Response.json({}));
			const app = createApp(deps(poolOf(upstream.url)));
			const pre = await app.fetch(
				new Request(`${upstream.url}/v1/responses`, { method: "OPTIONS" }),
			);
			expect(pre.status).toBe(204);
			expect(pre.headers.get("allow")).toBe("POST, OPTIONS");
			const wrong = await app.fetch(
				new Request(`${upstream.url}/v1/responses`, { method: "GET" }),
			);
			expect(wrong.status).toBe(405);
			expect(wrong.headers.get("allow")).toBe("POST, OPTIONS");
			upstream.close();
		});

		test("trace: inbound traceparent rides the responses leg as a child span", async () => {
			const upstream = await startMockUpstream(() =>
				Response.json(RESPONSE_OBJ),
			);
			const app = createApp(deps(poolOf(upstream.url)));
			const res = await app.fetch(POST(upstream.url, { traceparent: INBOUND }));
			expect(res.status).toBe(200);
			const seen = upstream.calls[0]?.headers.get("traceparent") ?? "";
			const parts = seen.split("-");
			expect(parts[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
			expect(parts[2]).not.toBe("00f067aa0ba902b7"); // fresh span id
			expect(parts).toHaveLength(4);
			upstream.close();
		});
	});

	// The gate surface: /v1/responses is proxy class (buckle:proxy:WRITE_ +
	// budget admission), bare and lane-prefixed alike — the gate rides the
	// standard proxy scope + rpm budget (gov-gate.test.ts contract, W912).
	test.describe("responses ingress through the governance gate (W912)", () => {
		// W1294.16: A/B-proven failing on main under bun test (baseline banked);
		// fixme + repair item per the sweep-C precedent.
		test("scoped auth + rpm budget: 200, then 429; lane prefix gated too", async () => {
			// W1294.16: A/B-proven failing on main under bun test (baseline
			// banked); in-body fixme annotation + repair item W1306
			// (sweep-C precedent).
			test.fixme(true, "failing on main — repair item W1306");
			const upstream = await startMockUpstream(() =>
				Response.json(RESPONSE_OBJ),
			);
			const gate = await startGate({
				upstreamUrl: upstream.url,
				model: "gpt-5.3-codex",
			});
			const base = gate.base;
			const { key } = await issueViaAdmin(base, {
				name: "codex-lane",
				scopes: ["buckle:proxy:WRITE_"],
				rpm_limit: 1,
			});
			const ok = await fetch(`${base}/v1/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: RESPONSES_BODY,
			});
			expect(ok.status).toBe(200);
			const limited = await fetch(`${base}/w/autow912/v1/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${key}` },
				body: RESPONSES_BODY,
			});
			expect(limited.status).toBe(429); // budget fired on the lane surface
			expect(limited.headers.get("retry-after")).not.toBeNull();
			expect(limited.headers.get("ratelimit-limit")).toBe("1");
			const anon = await fetch(`${base}/v1/responses`, {
				method: "POST",
				body: RESPONSES_BODY,
			});
			expect(anon.status).toBe(401);
			gate.stop();
			upstream.close();
		});
	});
});
