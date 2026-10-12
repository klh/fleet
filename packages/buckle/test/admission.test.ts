// test/admission.test.ts — W450 bounded RPC admission: slots, caps, and the
// explicit 429 + Retry-After at the bound (toto-gpt item 6 acceptance).
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MAX_INFLIGHT,
	RpcAdmission,
	parseGroupCaps,
} from "../src/admission.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import { parsePolicy } from "../src/policy.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const postChat = (
	app: AppDeps extends never ? never : { fetch(r: Request): Promise<Response> },
	url: string,
): Promise<Response> =>
	app.fetch(
		new Request(`${url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3-flash",
				messages: [{ role: "user", content: "hi" }],
			}),
		}),
	);

describe("RpcAdmission", () => {
	test("slots acquire and release", () => {
		const a = new RpcAdmission(2, 7, {});
		const r1 = a.tryAcquire("g");
		expect(r1).not.toBeNull();
		expect(a.inflight("g")).toBe(1);
		r1?.();
		expect(a.inflight("g")).toBe(0);
	});

	test("double release is a no-op", () => {
		const a = new RpcAdmission(1, 2, {});
		const r1 = a.tryAcquire("g");
		r1?.();
		r1?.();
		expect(a.inflight("g")).toBe(0);
	});

	test("full group refuses; release admits again", () => {
		const a = new RpcAdmission(2, 2, {});
		a.tryAcquire("g");
		const r2 = a.tryAcquire("g");
		expect(r2).not.toBeNull();
		expect(a.tryAcquire("g")).toBeNull();
		r2?.();
		expect(a.tryAcquire("g")).not.toBeNull();
	});

	test("group caps override the global cap; total() counts all groups", () => {
		const a = new RpcAdmission(8, 3, { local: 1 });
		expect(a.capOf("local")).toBe(1);
		expect(a.capOf("other")).toBe(8);
		const r1 = a.tryAcquire("local");
		expect(a.tryAcquire("local")).toBeNull();
		a.tryAcquire("other");
		expect(a.total()).toBe(2);
		r1?.();
		expect(a.total()).toBe(1);
	});

	test("parseGroupCaps: malformed entries dropped", () => {
		expect(parseGroupCaps("a:1,b, c:2,:3,d:x")).toEqual({ a: 1, c: 2 });
	});

	test("DEFAULT_MAX_INFLIGHT is bounded", () => {
		expect(DEFAULT_MAX_INFLIGHT).toBe(256);
	});
});

describe("admission at the wire (e2e)", () => {
	test("full group answers 429 + retry-after, not a queue", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "1", usage: { prompt_tokens: 1 } }),
		);
		const pool: UpstreamPool = {
			groups: () => ["glm-5.3-flash"],
			deployments: (g) =>
				g === "glm-5.3-flash"
					? [{ group: g, url: upstream.url, dialect: "openai" as const }]
					: [],
		};
		const deps = testDeps(pool, { policy: parsePolicy("version: 1\n") });
		deps.admission = new RpcAdmission(1, 3, {});
		const slot = deps.admission.tryAcquire("glm-5.3-flash"); // the bound
		const app = createApp(deps);
		const res = await postChat(app, upstream.url);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("3");
		slot?.();
		const res2 = await postChat(app, upstream.url);
		expect(res2.status).toBe(200);
		upstream.close();
	});
});
