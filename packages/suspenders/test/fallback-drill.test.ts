// fallback-drill.test.ts — W219.2: the keepwarm drill's contract. When z.ai
// is dark a 200-with-choices from the gateway proves a local rung answered;
// anything else on a dark z.ai is the 2026-10-06 incident recurring.
import { describe, expect, test } from "bun:test";
import {
	CACHE_SID,
	cacheHitShare,
	checkFallbacksPresent,
	drillCacheShare,
	drillFallback,
	drillFloor,
	drillRoutes,
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

// ---- W901.1 cache-share drill (audit finding 2) ----------------------------

const PREFIX = {
	model: "glm-5.3-flash",
	tools: [{ name: "Read" }],
	system: [{ type: "text", text: "harness preamble" }],
};

const usage = (cacheRead: number) =>
	JSON.stringify({
		usage: {
			input_tokens: 60,
			output_tokens: 1,
			cache_read_input_tokens: cacheRead,
			cache_creation_input_tokens: 0,
		},
	});

/** Stub front: per-call cache-read reports, cold then warm. Records the
 *  request URL + auth so the lane-path and key assertions ride it. */
function cacheFront(cacheReads: number[], opts?: { noFields?: boolean }) {
	let n = 0;
	const seen: { url: string; auth: string }[] = [];
	const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
		if (String(url).includes("/v1/messages")) {
			seen.push({
				url: String(url),
				auth: new Headers(init?.headers).get("authorization") ?? "",
			});
			const read = cacheReads[Math.min(n, cacheReads.length - 1)];
			n += 1;
			return new Response(opts?.noFields ? "{}" : usage(read), { status: 200 });
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
	return { impl, seen };
}

describe("drillCacheShare (W901.1)", () => {
	const DRILL = {
		front: "http://front.local",
		key: "bksk_k",
		routes: ["glm-5.3-flash"],
		prefix: PREFIX,
		floor: 0.5,
	};

	test("warm pair reports cache fields + share above floor = pass", async () => {
		const f = cacheFront([0, 1152]);
		const r = await drillCacheShare({
			...DRILL,
			fetchImpl: f.impl,
		});
		expect(r.verdict).toBe("pass");
		expect(r.routes[0]?.share).toBeCloseTo(1152 / 1212);
		expect(r.routes[0]?.why).toContain("floor");
		// both passes ride the attributed lane path with the drill key
		expect(
			f.seen.every((s) => s.url.includes(`/w/${CACHE_SID}/v1/messages`)),
		).toBe(true);
		expect(f.seen.every((s) => s.auth === "Bearer bksk_k")).toBe(true);
	});

	test("route answers but reports NO cache fields = fail (the alert)", async () => {
		const r = await drillCacheShare({
			...DRILL,
			fetchImpl: cacheFront([0, 0], { noFields: true }).impl,
		});
		expect(r.verdict).toBe("fail");
		expect(r.routes[0]?.share).toBeNull();
		expect(r.routes[0]?.why).toContain("NO cache usage fields");
	});

	test("warm share below floor = fail (affinity off / prefix drift)", async () => {
		const r = await drillCacheShare({
			...DRILL,
			fetchImpl: cacheFront([0, 10]).impl,
		});
		expect(r.verdict).toBe("fail");
		expect(r.routes[0]?.share).toBeCloseTo(10 / 70);
		expect(r.routes[0]?.why).toContain("below floor");
	});

	test("no captured prefix = skipped", async () => {
		const r = await drillCacheShare({
			...DRILL,
			prefix: null,
			fetchImpl: cacheFront([0]).impl,
		});
		expect(r.verdict).toBe("skipped");
	});

	test("multi-route: one failing route fails the aggregate", async () => {
		let n = 0;
		const split = (async () =>
			new Response(usage(n++ === 1 ? 1152 : 0), {
				status: 200,
			})) as unknown as typeof fetch;
		const r = await drillCacheShare({
			...DRILL,
			routes: ["glm-5.3-flash", "zai-glm-5.3-flash"],
			fetchImpl: split,
		});
		expect(r.verdict).toBe("fail");
		expect(r.routes.map((x) => x.verdict)).toEqual(["pass", "fail"]);
	});
});

describe("cache knobs (W901.1)", () => {
	test("cacheHitShare = reads over all input; no totals = null", () => {
		expect(
			cacheHitShare({ in_tok: 60, out_tok: 1, cache_r: 1152, cache_c: 0 }),
		).toBeCloseTo(1152 / 1212);
		expect(cacheHitShare(null)).toBeNull();
		expect(
			cacheHitShare({ in_tok: 0, out_tok: 1, cache_r: 0, cache_c: 0 }),
		).toBeNull();
	});

	test("drillRoutes: env wins, junk falls back to the audit set", () => {
		expect(drillRoutes({})).toEqual([
			"glm-5.3-flash",
			"zai-glm-5.3-flash",
			"local-swarm",
		]);
		expect(drillRoutes({ BELT_CACHE_DRILL_ROUTES: " a , b " })).toEqual([
			"a",
			"b",
		]);
		expect(drillRoutes({ BELT_CACHE_DRILL_ROUTES: ",," })).toHaveLength(3);
	});

	test("drillFloor: env wins, junk/out-of-range falls back to 0.5", () => {
		expect(drillFloor({})).toBe(0.5);
		expect(drillFloor({ BELT_CACHE_DRILL_FLOOR: "0.9" })).toBe(0.9);
		expect(drillFloor({ BELT_CACHE_DRILL_FLOOR: "junk" })).toBe(0.5);
		expect(drillFloor({ BELT_CACHE_DRILL_FLOOR: "3" })).toBe(0.5);
	});
});
