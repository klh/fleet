// fallback-drill.test.ts — W219.2: the keepwarm drill's contract. When z.ai
// is dark a 200-with-choices from the gateway proves a local rung answered;
// anything else on a dark z.ai is the 2026-10-06 incident recurring.
import { describe, expect, test } from "bun:test";
import {
	drillFallback,
	resolveMasterKey,
	zaiDark,
} from "../hooks/bin/fallback-drill.ts";

const OK_BODY = {
	model: "glm-5.3-flash",
	choices: [{ message: { content: "ok" } }],
};

/** Stub fetch: z.ai leg (status or throw) + gateway leg (status/body). */
function stubFetch(opts: {
	zai?: { status?: number; throw?: Error };
	gw?: { status: number; body?: unknown; throw?: Error };
}) {
	return (async (url: RequestInfo | URL): Promise<Response> => {
		const isZai = String(url).startsWith("https://api.z.ai");
		const leg = isZai ? opts.zai : opts.gw;
		if (!isZai && !String(url).includes("/v1/chat/completions"))
			throw new Error(`unexpected url ${url}`);
		if (leg?.throw) throw leg.throw;
		const status = leg && "status" in leg ? (leg.status ?? 200) : 200;
		const body = isZai ? null : JSON.stringify(opts.gw?.body ?? OK_BODY);
		return new Response(body ?? null, { status });
	}) as typeof fetch;
}

describe("zaiDark (W219.2)", () => {
	test("any HTTP reply = reachable", async () => {
		expect(await zaiDark(stubFetch({ zai: { status: 401 } }))).toBe(false);
		expect(await zaiDark(stubFetch({ zai: { status: 404 } }))).toBe(false);
	});

	test("a throw (TLS interception, timeout) = dark", async () => {
		expect(
			await zaiDark(stubFetch({ zai: { throw: new Error("tls") } })),
		).toBe(true);
	});
});

describe("drillFallback (W219.2)", () => {
	test("z.ai dark + gateway 200 = pass, local rung answered", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({
				zai: { throw: new Error("tls") },
				gw: { status: 200 },
			}),
		});
		expect(r.dark).toBe(true);
		expect(r.verdict).toBe("pass");
		expect(r.why).toContain("local rung");
		expect(r.model).toBe("glm-5.3-flash");
	});

	test("z.ai dark + gateway error = the 2026-10-06 incident, fail", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({
				zai: { throw: new Error("tls") },
				gw: { status: 500 },
			}),
		});
		expect(r.dark).toBe(true);
		expect(r.verdict).toBe("fail");
		expect(r.why).toContain("500");
	});

	test("z.ai reachable + gateway 200 = pass (drill doubles as serve proof)", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({ zai: { status: 401 }, gw: { status: 200 } }),
		});
		expect(r.dark).toBe(false);
		expect(r.verdict).toBe("pass");
	});

	test("gateway unreachable = fail with the throw surfaced", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({
				zai: { status: 200 },
				gw: { status: 200, throw: new Error("refused") },
			}),
		});
		expect(r.verdict).toBe("fail");
		expect(r.why).toContain("gateway unreachable");
	});

	test("no key anywhere = skipped, never a fake pass/fail", async () => {
		const r = await drillFallback({ key: null, fetchImpl: stubFetch({ gw: { status: 200 } }) });
		expect(r.verdict).toBe("skipped");
	});
});

describe("resolveMasterKey (W219.2)", () => {
	test("env wins over the file; neither = null", () => {
		const readThrows = () => {
			throw new Error("nope");
		};
		expect(
			resolveMasterKey({ LITELLM_KEY: "  env-key " }, readThrows),
		).toBe("env-key");
		expect(resolveMasterKey({}, readThrows)).toBeNull();
		expect(resolveMasterKey({}, () => "file-key\n")).toBe("file-key");
	});
});
