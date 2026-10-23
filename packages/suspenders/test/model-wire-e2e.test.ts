// test/model-wire-e2e.test.ts — W1092: the Belt-owned model wire, end to
// end over real HTTP hops. A real Buckle (startServer) routes a model group
// at Belt's model proxy (createModelProxy served over the wire), which
// fronts an Ollama-shaped upstream. Proves: /v1/models mirrors the live
// upstream inventory, one inference preserves the model id across both
// hops, the W3C trace id survives Buckle → Belt → Ollama, and Belt never
// forwards Buckle's key upstream.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelProxy } from "../../belt/bin/model-proxy.ts";
import { startServer } from "../../buckle/src/server.ts";

// The stand-in Ollama: OpenAI wire, /v1/models + /v1/chat/completions,
// recording every hop it sees so the far end of the chain is assertable.
const MODELS = ["qwen2.5:0.5b"];

interface OllamaHop {
	path: string;
	authorization: string | null;
	traceparent: string | null;
	model: string;
}
const hops: OllamaHop[] = [];

const ollama = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/v1/models")
			return Response.json({
				object: "list",
				data: MODELS.map((id) => ({ id, object: "model" })),
			});
		if (url.pathname === "/v1/chat/completions") {
			const body = (await request.json()) as { model: string };
			hops.push({
				path: url.pathname,
				authorization: request.headers.get("authorization"),
				traceparent: request.headers.get("traceparent"),
				model: body.model,
			});
			return Response.json({
				id: "chatcmpl-w1092",
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: body.model,
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "ok" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

// Belt's model proxy served over the network — Buckle → Belt is a real hop.
const belt = Bun.serve({
	port: 0,
	fetch: createModelProxy({ upstream: `http://127.0.0.1:${ollama.port}` }),
});

const dir = join(tmpdir(), `w1092-wire-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const upstreamsPath = join(dir, "upstreams.yaml");
writeFileSync(
	upstreamsPath,
	`version: 1
groups:
  qwen2.5:0.5b:
    - url: http://127.0.0.1:${belt.port}
      dialect: openai
`,
);
const policyPath = join(dir, "policy.yaml");
writeFileSync(
	policyPath,
	`version: 1
gateway:
  num_retries: 1
`,
);

// the gate is on (W193 posture): mint one proxy-WRITE key the way a lane
// or spoke does, and ride it for every Buckle call in this file
const ROOT = "fixture-w1092-root";
let ingressKey = ROOT;
const mintIngressKey = async (): Promise<void> => {
	if (ingressKey !== ROOT) return;
	const res = await fetch(`${base}/v1/admin/keys`, {
		method: "POST",
		headers: { authorization: `Bearer ${ROOT}` },
		body: JSON.stringify({
			name: "w1092-wire-e2e",
			scopes: ["buckle:proxy:WRITE_"],
		}),
	});
	ingressKey = ((await res.json()) as { key: string }).key;
};

const buckle = startServer({
	port: 0,
	upstreamsPath,
	policyPath,
	dbPath: ":memory:",
	auth: { rootKey: ROOT },
});

afterAll(() => {
	buckle.stop(true);
	belt.stop(true);
	ollama.stop(true);
});

const base = `http://127.0.0.1:${buckle.port}`;
const beltBase = `http://127.0.0.1:${belt.port}`;

const modelIds = (body: unknown): string[] =>
	((body as { data?: { id?: unknown }[] }).data ?? [])
		.map((item) => (typeof item.id === "string" ? item.id : ""))
		.filter((id) => id.length > 0);

const freshTraceparent = (): { header: string; id: string } => {
	const id = Array.from(crypto.getRandomValues(new Uint8Array(16)))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return { header: `00-${id}-5f5b0f0a1c2d3e4f-01`, id };
};

describe("W1092 Belt model wire", () => {
	test("Belt /v1/models mirrors the live upstream inventory", async () => {
		const res = await fetch(`${beltBase}/v1/models`);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-klh-hop")).toBe("belt");
		expect(res.headers.get("x-klh-service")).toBe("belt-model-proxy");
		expect(modelIds(await res.json())).toEqual(["qwen2.5:0.5b"]);
		// the catalog is inventory, never a fixed list: an upstream model
		// added after boot shows up on the next poll
		MODELS.push("another-local-model");
		const grown = await fetch(`${beltBase}/v1/models`);
		expect(modelIds(await grown.json())).toEqual([
			"qwen2.5:0.5b",
			"another-local-model",
		]);
	});

	test("Buckle route catalog carries the Belt-fronted group", async () => {
		await mintIngressKey();
		const res = await fetch(`${base}/v1/models`, {
			headers: { authorization: `Bearer ${ingressKey}` },
		});
		expect(res.status).toBe(200);
		expect(modelIds(await res.json())).toContain("qwen2.5:0.5b");
	});

	test("inference Buckle → Belt → Ollama keeps identity + trace, leaks no key", async () => {
		await mintIngressKey();
		const trace = freshTraceparent();
		const res = await fetch(`${base}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${ingressKey}`,
				traceparent: trace.header,
			},
			body: JSON.stringify({
				model: "qwen2.5:0.5b",
				messages: [{ role: "user", content: "ping" }],
			}),
		});
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			model: string;
			choices: { message: { content: string } }[];
		};
		expect(out.model).toBe("qwen2.5:0.5b");
		expect(out.choices[0]?.message.content).toBe("ok");
		// the far end saw exactly one hop, model id untouched, no Buckle key
		// past Belt, and the SAME W3C trace id the client rooted
		expect(hops.length).toBe(1);
		const hop = hops[0] as OllamaHop;
		expect(hop.path).toBe("/v1/chat/completions");
		expect(hop.model).toBe("qwen2.5:0.5b");
		expect(hop.authorization).toBeNull();
		expect(hop.traceparent?.split("-")[1]).toBe(trace.id);
	});
});
