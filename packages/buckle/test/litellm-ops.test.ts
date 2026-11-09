// test/litellm-ops.test.ts — W914 ops passthrough contract: byte-faithful
// relay (multipart/binary fidelity), verbatim upstream error bodies, honest
// 503 when the ops group is absent, 502 on transport failure, lane
// attribution rides the pipe, admission 429 at the cap, the audit row
// carries the no-injection reason, and the group is policy-knobbed.
import { describe, expect, test } from "bun:test";
import { RpcAdmission } from "../src/admission.ts";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

function opsPool(url: string, group = "litellm-ops"): UpstreamPool {
	return {
		groups: () => [group],
		deployments: (g) => [{ group: g, url, dialect: "openai" as const }],
	};
}

function opsApp(url: string, group?: string) {
	const d = testDeps(opsPool(url, group), {
		policy: group === undefined ? {} : { litellm_ops: { group } },
	});
	return { d, app: createApp(d) };
}

describe("litellm ops passthrough (W914)", () => {
	test("multipart fidelity: /v1/files rides bytes + content-type verbatim", async () => {
		const upstream = await startMockUpstream(
			async (req) => {
				const form = await req.formData();
				const f = form.get("file");
				if (!(f instanceof File))
					return Response.json({ error: "no file field" }, { status: 400 });
				return Response.json({
					ok: true,
					name: f.name,
					content: await f.text(),
					multipart: (req.headers.get("content-type") ?? "").startsWith(
						"multipart/form-data",
					),
				});
			},
			{ raw: true },
		);
		const { d, app } = opsApp(upstream.url);
		const form = new FormData();
		form.set("file", new File(["hello ops"], "a.txt"));
		form.set("purpose", "batch");
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/files`, { method: "POST", body: form }),
		);
		expect(res.status).toBe(200);
		const out = (await res.json()) as {
			ok: boolean;
			name: string;
			content: string;
			multipart: boolean;
		};
		expect(out).toEqual({
			ok: true,
			name: "a.txt",
			content: "hello ops",
			multipart: true,
		});
		expect(d.ledger.auditRows().some((r) => r.decision === "delivered")).toBe(
			true,
		);
		upstream.close();
	});

	test("async jobs: /v1/batches POST + GET {id} round-trip byte-faithful", async () => {
		const upstream = await startMockUpstream((_req, _body, n) =>
			n === 1
				? Response.json({ id: "bat_1", status: "validating" })
				: Response.json({ id: "bat_1", status: "completed" }),
		);
		const { app } = opsApp(upstream.url);
		const post = await app.fetch(
			new Request(`${upstream.url}/v1/batches`, {
				method: "POST",
				body: JSON.stringify({ input_file_id: "file_1" }),
			}),
		);
		expect(post.status).toBe(200);
		expect(await post.json()).toEqual({ id: "bat_1", status: "validating" });
		const get = await app.fetch(
			new Request(`${upstream.url}/v1/batches/bat_1`),
		);
		expect(get.status).toBe(200);
		expect(await get.json()).toEqual({ id: "bat_1", status: "completed" });
		upstream.close();
	});

	test("upstream error semantics preserved: 429 body rides through verbatim", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json(
				{ error: { message: "provider quota wall", code: "rate_limit" } },
				{ status: 429 },
			),
		);
		const { app } = opsApp(upstream.url);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/batches/bat_1`),
		);
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({
			error: { message: "provider quota wall", code: "rate_limit" },
		});
		upstream.close();
	});

	test("503 buckle.ops_unconfigured when the group is absent", async () => {
		const d = testDeps({ groups: () => [], deployments: () => [] });
		const app = createApp(d);
		const res = await app.fetch(
			new Request("http://buckle.test/v1/batches/bat_1"),
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("buckle.ops_unconfigured");
	});

	test("502 buckle.upstream_error on transport failure", async () => {
		const upstream = await startMockUpstream(() => Response.json({}));
		upstream.close(); // guaranteed-closed port
		const { app } = opsApp(upstream.url);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/batches/bat_1`),
		);
		expect(res.status).toBe(502);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe("buckle.upstream_error");
	});

	test("lane attribution: /w/<slug> strips to the bare path, rides the audit + header", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "bat_1", status: "completed" }),
		);
		const { d, app } = opsApp(upstream.url);
		const res = await app.fetch(
			new Request(`${upstream.url}/w/lane9/v1/batches/bat_1`),
		);
		expect(res.status).toBe(200);
		expect(upstream.calls[0]?.path).toBe("/v1/batches/bat_1");
		const route = JSON.parse(res.headers.get("x-belt-route") ?? "{}") as {
			lane?: string;
		};
		expect(route.lane).toBe("lane9");
		const audit = d.ledger.auditRows().at(-1) as
			| { lane?: string; why?: string }
			| undefined;
		expect(audit?.lane).toBe("lane9");
		expect(audit?.why).toContain("injection: none");
		upstream.close();
	});

	test("admission cap: 429 + retry-after at the in-flight bound", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "bat_1" }),
		);
		const { d } = opsApp(upstream.url);
		const ad = new RpcAdmission(1, 3, {});
		const release = ad.tryAcquire("litellm-ops");
		expect(release).not.toBeNull();
		const appCapped = createApp({ ...d, admission: ad });
		const res = await appCapped.fetch(
			new Request(`${upstream.url}/v1/batches/bat_1`),
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("3");
		release?.();
		upstream.close();
	});

	test("ops group is policy-knobbed (config-over-code)", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "bat_1", status: "completed" }),
		);
		const { app } = opsApp(upstream.url, "custom-ops");
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/batches/bat_1`),
		);
		expect(res.status).toBe(200);
		upstream.close();
	});

	test("default group: a custom knob pointing elsewhere 503s honestly", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "bat_1", status: "completed" }),
		);
		const d2 = testDeps(opsPool(upstream.url, "custom-ops"));
		const app2 = createApp(d2);
		const res2 = await app2.fetch(
			new Request(`${upstream.url}/v1/batches/bat_1`),
		);
		expect(res2.status).toBe(503);
		upstream.close();
	});

	test("registry negatives: unregistered 404, wrong method 405", async () => {
		const upstream = await startMockUpstream(() => Response.json({}));
		const { app } = opsApp(upstream.url);
		const nope = await app.fetch(
			new Request(`${upstream.url}/v1/nope`, { method: "POST", body: "{}" }),
		);
		expect(nope.status).toBe(404);
		const wrong = await app.fetch(new Request(`${upstream.url}/v1/embeddings`));
		expect(wrong.status).toBe(405);
		// parametric negatives: trailing segment is unregistered
		const extra = await app.fetch(
			new Request(`${upstream.url}/v1/batches/bat_1/extra`),
		);
		expect(extra.status).toBe(404);
		upstream.close();
	});

	test("registry document at the wire: GET /v1/endpoints (bare + lane)", async () => {
		const upstream = await startMockUpstream(() => Response.json({}));
		const { app } = opsApp(upstream.url);
		const res = await app.fetch(new Request(`${upstream.url}/v1/endpoints`));
		expect(res.status).toBe(200);
		const doc = (await res.json()) as {
			registry_version: number;
			agents: { agent: string }[];
		};
		expect(doc.registry_version).toBe(1);
		expect(doc.agents.map((a) => a.agent)).toEqual([
			"claude",
			"codex",
			"copilot",
		]);
		const lane = await app.fetch(
			new Request(`${upstream.url}/w/lane1/v1/endpoints`),
		);
		expect(lane.status).toBe(200);
		upstream.close();
	});

	test("aids skip injection on registry:no-injection dialect paths", async () => {
		const upstream = await startMockUpstream(() => Response.json({ data: [] }));
		const { d, app } = opsApp(upstream.url);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/embeddings`, {
				method: "POST",
				body: JSON.stringify({ model: "gpt-4", input: "hi" }),
			}),
		);
		expect(res.status).toBe(200);
		const audit = d.ledger.auditRows().at(-1) as { why?: string } | undefined;
		expect(audit?.why).toContain("aids skipped");
		upstream.close();
	});
});
