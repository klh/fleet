// test/router-probe-recovery.test.ts - W1077: benched walls must not outlive
// the upstream. Covers BOTH walks: the no-sel execute() tier walk and the
// PRODUCTION selected path (walkSelected rate-limit skip branch) - handlers.ts
// always passes req.sel, so the selected regression is the real proof.
import { describe, expect, test } from "bun:test";
import { Cooldowns } from "../src/cooldown.ts";
import { parsePolicy } from "../src/policy.ts";
import { Router } from "../src/router.ts";
import type { UpstreamPool } from "../src/upstreams.ts";

const POLICY = parsePolicy(`
gateway:
  num_retries: 1
  allowed_fails: 2
  cooldown_time: 30
tags:
  glm-5.3-flash: [fast, general]
`);

const pool: UpstreamPool = {
	groups: () => ["glm-5.3-flash"],
	deployments: (g) =>
		(g === "glm-5.3-flash" ? ["http://leg-a"] : []).map((url) => ({
			group: g,
			url,
			dialect: "openai" as const,
		})),
};

const dep = pool.deployments("glm-5.3-flash")[0];

const req = {
	group: "glm-5.3-flash",
	dialect: "openai" as const,
	body: { model: "glm-5.3-flash", messages: [] },
} as Parameters<Router["execute"]>[0];

const selReq = {
	...req,
	sel: {
		verb: "prefer" as const,
		fit: 1,
		total: 1,
		prefs: { allow_cloud: true, cost_speed: "balanced" as const },
		cloudGroups: [],
		ordered: [
			{
				kind: "same" as const,
				group: "glm-5.3-flash",
				candidate_id: "c1",
				dep,
			},
		],
	},
} as Parameters<Router["execute"]>[0];

function benchedCooldowns(): Cooldowns {
	const cooldowns = new Cooldowns(2, 30);
	cooldowns.failure(dep, "rate_limited");
	cooldowns.failure(dep, "rate_limited"); // bench reached (allowed_fails 2)
	return cooldowns;
}

const LIVE_PROBE = async () => Response.json({ data: [] });
const DEAD_PROBE = async () => null;

describe("W1077 probe-before-fail", () => {
	test("no-sel walk: live probe clears the bench and serves", async () => {
		const router = new Router(POLICY, {
			pool,
			cooldowns: benchedCooldowns(),
			sleepMs: async () => {},
			probe: LIVE_PROBE,
			fetchImpl: async () => Response.json({ ok: true }),
		});
		const result = await router.execute(req);
		expect(result.kind).toBe("upstream");
	});

	test("no-sel walk: dead probe stays benched - typed local 503 hold", async () => {
		const router = new Router(POLICY, {
			pool,
			cooldowns: benchedCooldowns(),
			sleepMs: async () => {},
			probe: DEAD_PROBE,
			fetchImpl: async () => Response.json({ ok: true }),
		});
		const result = await router.execute(req);
		// W1257: a benched tier with a dead probe answers a typed LOCAL hold,
		// never a fabricated provider 429
		expect(result.kind).toBe("exhausted");
		if (result.kind !== "exhausted") throw new Error("hold lost");
		expect(result.status).toBe(503);
		expect(result.error).toContain("gateway cooldown");
		expect(result.error).toContain("not the provider");
	});

	test("selected path (production): benched row recovers on live probe", async () => {
		const probeHits: string[] = [];
		const router = new Router(POLICY, {
			pool,
			cooldowns: benchedCooldowns(),
			sleepMs: async () => {},
			probe: async (d) => {
				probeHits.push(d.url);
				return Response.json({ data: [] });
			},
			fetchImpl: async () => Response.json({ ok: true }),
		});
		const result = await router.execute(selReq);
		expect(result.kind).toBe("upstream");
		expect(probeHits).toEqual(["http://leg-a"]);
	});
});
