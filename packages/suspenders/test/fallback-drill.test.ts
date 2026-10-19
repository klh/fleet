// fallback-drill.test.ts — W219.2: the keepwarm drill's contract. When z.ai
// is dark a 200-with-choices from the gateway proves a local rung answered;
// anything else on a dark z.ai is the 2026-10-06 incident recurring.
import { describe, expect, test } from "bun:test";
import {
	checkFallbacksPresent,
	drillFallback,
	resolveMasterKey,
	zaiDark,
} from "../hooks/bin/fallback-drill.ts";

const OK_BODY = {
	model: "glm-5.3-flash",
	choices: [{ message: { content: "ok" } }],
};

/** The emitted litellm_settings shape (belt emitFallbackSettings). */
const WITH_LADDERS = [
	"router_settings:",
	"  num_retries: 1",
	"litellm_settings:",
	"  fallbacks:",
	"    - glm-5.3-flash: [local-swarm, glm-5.3]",
	"    - glm-5.3: [local-swarm]",
	"general_settings:",
	"  master_key: os.environ/LITELLM_KEY",
].join("\n");

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
		expect(await zaiDark(stubFetch({ zai: { throw: new Error("tls") } }))).toBe(
			true,
		);
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
			readConfig: () => WITH_LADDERS,
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
			readConfig: () => WITH_LADDERS,
		});
		expect(r.dark).toBe(true);
		expect(r.verdict).toBe("fail");
		expect(r.why).toContain("500");
	});

	test("z.ai reachable + gateway 200 = pass (drill doubles as serve proof)", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({ zai: { status: 401 }, gw: { status: 200 } }),
			readConfig: () => WITH_LADDERS,
		});
		expect(r.dark).toBe(false);
		expect(r.verdict).toBe("pass");
		expect(r.laddersPresent).toBe(true);
	});

	test("gateway unreachable = fail with the throw surfaced", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({
				zai: { status: 200 },
				gw: { status: 200, throw: new Error("refused") },
			}),
			readConfig: () => WITH_LADDERS,
		});
		expect(r.verdict).toBe("fail");
		expect(r.why).toContain("gateway unreachable");
	});

	test("no key anywhere = skipped, never a fake pass/fail", async () => {
		const r = await drillFallback({
			key: null,
			fetchImpl: stubFetch({ gw: { status: 200 } }),
		});
		expect(r.verdict).toBe("skipped");
	});
});

describe("resolveMasterKey (W219.2)", () => {
	test("env wins over the file; neither = null", () => {
		const readThrows = () => {
			throw new Error("nope");
		};
		expect(resolveMasterKey({ LITELLM_KEY: "  env-key " }, readThrows)).toBe(
			"env-key",
		);
		expect(resolveMasterKey({}, readThrows)).toBeNull();
		expect(resolveMasterKey({}, () => "file-key\n")).toBe("file-key");
	});
});

describe("checkFallbacksPresent (W878)", () => {
	test("emitted shape: single-key map rows → groups extracted", () => {
		const c = checkFallbacksPresent(WITH_LADDERS);
		expect(c.present).toBe(true);
		expect(c.groups).toEqual(["glm-5.3-flash", "glm-5.3"]);
	});

	test("no litellm_settings block = absent (the live F1 shape)", () => {
		const c = checkFallbacksPresent("model_list:\n  - model_name: x\n");
		expect(c.present).toBe(false);
		expect(c.why).toContain("fallbacks");
	});

	test("empty fallbacks list = absent", () => {
		const c = checkFallbacksPresent("litellm_settings:\n  fallbacks: []\n");
		expect(c.present).toBe(false);
	});

	test("non-map rows = absent", () => {
		const c = checkFallbacksPresent(
			"litellm_settings:\n  fallbacks:\n    - 7\n",
		);
		expect(c.present).toBe(false);
		expect(c.why).toContain("no usable rows");
	});

	test("unparseable YAML = absent", () => {
		const c = checkFallbacksPresent("foo: [unclosed");
		expect(c.present).toBe(false);
		expect(c.why).toContain("unparseable");
	});
});

describe("drillFallback ladder assertion (W878)", () => {
	test("z.ai up + gw 200 but no ladders in config = fail (F2 gap closed)", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({ zai: { status: 401 }, gw: { status: 200 } }),
			readConfig: () => "router_settings:\n  num_retries: 1\n",
		});
		expect(r.dark).toBe(false);
		expect(r.verdict).toBe("fail");
		expect(r.laddersPresent).toBe(false);
		expect(r.why).toContain("fallbacks");
	});

	test("gateway config unreadable = fail even while the gateway answers", async () => {
		const r = await drillFallback({
			key: "k",
			fetchImpl: stubFetch({ zai: { status: 401 }, gw: { status: 200 } }),
			readConfig: () => {
				throw new Error("EACCES");
			},
		});
		expect(r.verdict).toBe("fail");
		expect(r.why).toContain("unreadable");
	});

	test("skipped (no key) never reads the config", async () => {
		const r = await drillFallback({
			key: null,
			fetchImpl: stubFetch({ gw: { status: 200 } }),
			readConfig: () => {
				throw new Error("must not be called");
			},
		});
		expect(r.verdict).toBe("skipped");
	});
});
