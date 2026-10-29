// provider-pools.e2e.ts — W2263 co-situated proof: provider-neutral
// per-pool capacity (schema, ceilings, occupancy dedupe, fenced
// reservation) + Kev placement over the live snapshot + the ONE
// effective refill target (#89251 RCA regression).
import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { openStore } from "../govdb/govdb.ts";
import { kevPlacement, placementCandidates } from "./kev-placement.ts";
import { buildPoolRampPlan, stageRouteArg } from "./pool-ramp-plan.ts";
import {
	automaticCeiling,
	poolOfModel,
	poolOccupancy,
	resolveProviderPools,
	reservePoolSlot,
} from "./provider-pools.ts";
import { effectiveDispatchTarget, fleetLoopSettings } from "../stack-config.ts";

const world = scratchWorld({ prefix: "provider-pools-" });
const realHome = process.env.HOME;
process.env.HOME = world.home;
const store = openStore();

const stamp = (sid, model, fact) =>
	store
		.query(
			"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'test', 1, ?)",
		)
		.run(`lane.${sid}.${fact}`, model, Date.now());

const poolsDoc = {
	"zai-coding": {
		models: ["zai-glm-5.3", "zai-glm-5.3-flash", "zai-glm-4.5-air"],
		concurrency: 10,
		interactive_reserve: 2,
		quota_pool_id: "zai-account",
	},
	"glm-full": { models: ["glm-5.3"], concurrency: 8 },
};

test.afterAll(() => {
	store.close();
	process.env.HOME = realHome;
	world.clean();
});

test("resolveProviderPools: valid doc passes, ceiling nets out the reserve", () => {
	const pools = resolveProviderPools({
		fleet_loop: { provider_pools: poolsDoc },
	});
	expect(Object.keys(pools).sort()).toEqual(["glm-full", "zai-coding"]);
	expect(automaticCeiling(pools["zai-coding"])).toBe(8);
	expect(automaticCeiling(pools["glm-full"])).toBe(8);
	// alias collapse: every zai alias maps to the ONE quota-collapsed key
	for (const m of poolsDoc["zai-coding"].models)
		expect(poolOfModel(pools, m)?.key).toBe("zai-account");
});

test("resolveProviderPools: malformed + alias-in-two-pools throw loud", () => {
	expect(() =>
		resolveProviderPools({
			fleet_loop: {
				provider_pools: { bad: { models: ["m"], concurrency: 0 } },
			},
		}),
	).toThrow(/provider_pools\.bad\.concurrency/);
	expect(() =>
		resolveProviderPools({
			fleet_loop: {
				provider_pools: {
					a: { models: ["shared"], concurrency: 4 },
					b: { models: ["shared"], concurrency: 4, quota_pool_id: "x" },
				},
			},
		}),
	).toThrow(/shared/);
	expect(resolveProviderPools(null)).toEqual({});
});

test("poolOccupancy counts each lane once (pool fact wins over model fact)", () => {
	const pools = resolveProviderPools({
		fleet_loop: { provider_pools: poolsDoc },
	});
	store.query("DELETE FROM facts WHERE key GLOB 'lane.pooltest-*'").run();
	stamp("lane.pooltest-a", "zai-account", "pool");
	stamp("lane.pooltest-a", "zai-glm-5.3", "model"); // same sid, both facts
	stamp("lane.pooltest-b", "zai-glm-4.5-air", "model"); // legacy: model only
	const { counts } = poolOccupancy(store, pools);
	expect(counts.get("zai-account")).toBe(2); // NOT 3 — dedupe per sid
});

test("reservePoolSlot: fenced ceiling across aliases, WAIT past it", () => {
	const pools = resolveProviderPools({
		fleet_loop: {
			provider_pools: {
				zai: { models: ["m1", "m2"], concurrency: 4, interactive_reserve: 2 },
			},
		},
	});
	store.query("DELETE FROM facts WHERE key GLOB 'lane.resv-*'").run();
	const outcomes = [];
	for (let i = 0; i < 4; i++)
		outcomes.push(
			reservePoolSlot({
				store,
				pools,
				sid: `resv-${i}`,
				model: i % 2 ? "m1" : "m2",
			}),
		);
	// 2 slots only (10-ceiling math: concurrency 4 − reserve 2)
	expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
	const refused = reservePoolSlot({ store, pools, sid: "resv-x", model: "m2" });
	expect(refused.ok).toBe(false);
	if (!refused.ok) expect(refused.reason).toMatch(/full.*2\/2/);
});

test("placement: pinned model on a full pool refuses (WAIT, never reroute)", async () => {
	const pools = resolveProviderPools({
		fleet_loop: { provider_pools: poolsDoc },
	});
	const counts = new Map([
		["zai-account", 8],
		["glm-full", 8],
	]);
	const snap = placementCandidates({
		pools,
		counts,
		cooling: new Map(),
		walls: 0,
		pinnedModel: "zai-glm-4.5-air",
	});
	expect(snap.candidates).toHaveLength(0); // pin restricts to its own full pool
	const verdict = await kevPlacement({
		pools,
		counts,
		cooling: new Map(),
		walls: 0,
		pinnedModel: "zai-glm-4.5-air",
	});
	expect(verdict.ok).toBe(false);
	if (!verdict.ok) expect(verdict.reason).toMatch(/WAIT, never reroute/);
});

test("placement: pinned model outside every pool rides no ceiling", async () => {
	const pools = resolveProviderPools({
		fleet_loop: { provider_pools: poolsDoc },
	});
	const verdict = await kevPlacement({
		pools,
		counts: new Map([["zai-account", 8]]),
		cooling: new Map(),
		walls: 0,
		pinnedModel: "gpt-x",
	});
	expect(verdict.ok).toBe(true);
	if (verdict.ok) {
		expect(verdict.decision.via).toBe("pinned");
		expect(verdict.decision.model).toBe("gpt-x");
	}
});

test("placement: deterministic fallback picks most headroom when kev is down", async () => {
	const pools = resolveProviderPools({
		fleet_loop: { provider_pools: poolsDoc },
	});
	const verdict = await kevPlacement({
		pools,
		counts: new Map([
			["zai-account", 7],
			["glm-full", 1],
		]),
		cooling: new Map(),
		walls: 0,
		pinnedModel: null,
		timeoutMs: 1, // kev cannot answer in 1ms → deterministic path
	});
	expect(verdict.ok).toBe(true);
	if (verdict.ok) {
		expect(verdict.decision.poolKey).toBe("glm-full"); // headroom 7 vs 1
		expect(verdict.decision.reason).toMatch(/headroom/);
	}
});

test("#89251 regression: effective target = min(lane_target, dispatch_target)", () => {
	// the operator reduced dispatch_target 12→8 while lane_target stayed 20 —
	// the loop used to pass lane_target and bypass the reduction entirely
	const s = fleetLoopSettings({
		fleet_loop: { lane_target: 20, dispatch_target: 8 },
	});
	expect(effectiveDispatchTarget(s)).toBe(8);
	expect(
		effectiveDispatchTarget(
			fleetLoopSettings({ fleet_loop: { lane_target: 5, dispatch_target: 8 } }),
		),
	).toBe(5); // either knob bounds refill
});

test("ramp plan: staged ceilings below proven occupancy, capacity-ramp route args", () => {
	const pools = resolveProviderPools({
		fleet_loop: { provider_pools: poolsDoc },
	});
	const plan = buildPoolRampPlan({
		pools,
		counts: new Map([
			["zai-account", 4],
			["glm-full", 0],
		]),
	});
	const zai = plan.stages.filter((s) => s.poolKey === "zai-account");
	// ceiling 8, admitted 4 → only stages ABOVE 4 lanes remain
	expect(zai.map((s) => s.lanes)).toEqual([6, 8]);
	const glm = plan.stages.filter((s) => s.poolKey === "glm-full");
	expect(glm.map((s) => s.lanes)).toEqual([2, 4, 6, 8]);
	expect(stageRouteArg(zai[0])).toBe("zai-account-s75=zai-glm-5.3@messages");
	expect(plan.notes.join(" ")).toMatch(/negative-results/);
});
