// model-health@unit.e2e.ts — W2194: the hub model-health sweep + the
// pin-layer fallback it feeds. Verdict mapping (auth/404 unknown, never
// poison), the 15-minute expiry law (stale = unknown, never healthy), the
// merge (any up beats down), the picker (freshest healthy, pinned excluded,
// none fresh = pin stands), the re-pin face (dispatch + review-scheduler),
// the sweep roundtrip through a real store, and the W1302.6 audit property:
// a re-pin rewrites the REQUEST, so serving the old pin is still a mismatch.
import { expect, test } from "@playwright/test";
import { openMemoryStore } from "../hooks/lib/govdb/govdb.ts";
import {
	bankModelHealth,
	downModelGroups,
	healthKeyOf,
	healthStatusOf,
	MODEL_HEALTH_STALE_MS,
	mergedGroupValues,
	pickHealthyGroup,
	probeVerdictOf,
	readModelHealthFacts,
	rePinModelPick,
	sweepOnce,
} from "../hooks/lib/hub/model-health.ts";
import { wireModelMismatch } from "../hooks/lib/gates/wire-model-check.ts";

const NOW = 1_800_000_000_000;
const mkDb = () => {
	const db = openMemoryStore();
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
	);
	return db;
};
const fact = (o) => ({
	latencyMs: 120,
	servedModel: "served-x",
	hub: "nas",
	wireId: "glm-5.3-flash",
	reason: null,
	...o,
});

test.describe("@unit model-health (W2194)", () => {
	test("probe verdict mapping: 2xx up; auth/404 unknown; 5xx/transport down", () => {
		expect(probeVerdictOf(200, { model: "served-x" }, null)).toEqual({
			status: "up",
			servedModel: "served-x",
			reason: null,
		});
		expect(probeVerdictOf(200, null, null).servedModel).toBeNull();
		expect(probeVerdictOf(401, null, null).status).toBe("unknown");
		expect(probeVerdictOf(404, null, null).status).toBe("unknown");
		expect(probeVerdictOf(500, null, null).status).toBe("down");
		expect(probeVerdictOf(null, null, "boom").status).toBe("down");
	});

	test("expiry law: missing/stale facts read unknown — stale up is never healthy", () => {
		expect(healthStatusOf(undefined, NOW)).toBe("unknown");
		expect(healthStatusOf(fact({ status: "up", ts: NOW - 60_000 }), NOW)).toBe(
			"up",
		);
		expect(
			healthStatusOf(
				fact({ status: "up", ts: NOW - MODEL_HEALTH_STALE_MS - 1 }),
				NOW,
			),
		).toBe("unknown");
		expect(
			healthStatusOf(
				fact({ status: "down", ts: NOW - MODEL_HEALTH_STALE_MS - 1 }),
				NOW,
			),
		).toBe("unknown");
	});

	test("merge: any up beats down/unknown; the winner's hub + wireId ride", () => {
		const rows = [
			fact({ status: "down", hub: "nas", wireId: "glm-5.3-flash", ts: NOW }),
			fact({
				status: "up",
				hub: "desktop",
				wireId: "glm-5.3-flash",
				ts: NOW,
				latencyMs: 900,
			}),
			fact({
				status: "up",
				hub: "spoke",
				wireId: "glm-5.3-flash",
				ts: NOW,
				latencyMs: 100,
			}),
		];
		const merged = mergedGroupValues(rows);
		const win = merged.get("glm-5-3-flash");
		expect(win.status).toBe("up");
		expect(win.hub).toBe("spoke");
		expect(win.wireId).toBe("glm-5.3-flash");
	});

	test("picker: DOWN pin → freshest healthy group; none fresh → null (pin stands); stale excluded", () => {
		const facts = new Map([
			["model.health.glm-5-3-flash", fact({ status: "down", ts: NOW })],
			[
				"model.health.glm-4-5-air",
				fact({ status: "up", ts: NOW - 60_000, wireId: "glm-4.5-air" }),
			],
			[
				"model.health.claude-haiku-4-5",
				fact({ status: "up", ts: NOW - 120_000, wireId: "claude-haiku-4-5" }),
			],
		]);
		const pick = pickHealthyGroup(facts, "zai-glm-5.3-flash", NOW);
		expect(pick?.group).toBe("glm-4.5-air");
		expect(pick?.core).toBe("glm-4-5-air");
		// nothing fresh at all → no fallback invented
		const dead = new Map([
			["model.health.glm-5-3-flash", fact({ status: "down", ts: NOW })],
		]);
		expect(pickHealthyGroup(dead, "glm-5.3-flash", NOW)).toBeNull();
		// a healthy-but-stale row is NOT a fallback target
		const stale = new Map([
			["model.health.glm-5-3-flash", fact({ status: "down", ts: NOW })],
			[
				"model.health.glm-4-5-air",
				fact({ status: "up", ts: NOW - MODEL_HEALTH_STALE_MS - 1 }),
			],
		]);
		expect(pickHealthyGroup(stale, "glm-5.3-flash", NOW)).toBeNull();
	});

	test("re-pin face: DOWN pin re-pins loudly; absent facts leave the pin; healthy pin no-op", () => {
		const db = mkDb();
		bankModelHealth(
			db,
			new Map([
				["glm-5-3-flash", fact({ status: "down", ts: Date.now() })],
				[
					"glm-4-5-air",
					fact({
						status: "up",
						ts: Date.now(),
						wireId: "glm-4.5-air",
						latencyMs: 80,
					}),
				],
			]),
		);
		const re = rePinModelPick(db, "glm-5.3-flash");
		expect(re.model).toBe("glm-4.5-air");
		expect(re.note).toContain("re-pinned to glm-4.5-air");
		// no facts at all → the sweep hasn't spoken; silence, the pin stands
		const none = rePinModelPick(mkDb(), "glm-5.3-flash");
		expect(none.model).toBeUndefined();
		expect(none.note).toBeNull();
		// facts exist but nothing fresh-healthy → LOUD pin-stands NOTE
		const staleOnly = mkDb();
		bankModelHealth(
			staleOnly,
			new Map([
				["glm-5-3-flash", fact({ status: "down", ts: Date.now() })],
				[
					"glm-4-5-air",
					fact({
						status: "up",
						ts: Date.now() - MODEL_HEALTH_STALE_MS - 1,
						wireId: "glm-4.5-air",
					}),
				],
			]),
		);
		const stands = rePinModelPick(staleOnly, "glm-5.3-flash");
		expect(stands.model).toBeUndefined();
		expect(stands.note).toContain("pin stands");
		// a fresh-healthy pin never re-pins
		const healthy = mkDb();
		bankModelHealth(
			healthy,
			new Map([
				[
					"glm-4-5-air",
					fact({ status: "up", ts: Date.now(), wireId: "glm-4.5-air" }),
				],
			]),
		);
		expect(rePinModelPick(healthy, "glm-4.5-air").model).toBeUndefined();
		// the fact key rides the modelCore of the catalog spelling — a lone
		// hub-prefixed spelling keeps its prefix in the key...
		expect(healthKeyOf("zai-glm-5.3-flash")).toBe(
			"model.health.zai-glm-5-3-flash",
		);
		// ...but the MERGE folds hub prefixes by class (the dash-extension
		// law), and the shorter spelling names the group
		const merged = mergedGroupValues([
			fact({
				status: "down",
				hub: "nas",
				wireId: "zai-glm-5.3-flash",
				ts: NOW,
			}),
			fact({ status: "up", hub: "spoke", wireId: "glm-5.3-flash", ts: NOW }),
		]);
		expect(merged.has("glm-5-3-flash")).toBe(true);
		expect(merged.get("glm-5-3-flash")?.hub).toBe("spoke");
	});

	test("sweep roundtrip: injected hubs/probes bank facts; down groups surface", async () => {
		const db = mkDb();
		const hubs = [
			{ label: "nas", url: "http://nas:4101", key: "k" },
			{ label: "spoke", url: "http://127.0.0.1:4101", key: "k" },
		];
		const verdicts = {
			"glm-5.3-flash": {
				status: "down",
				latencyMs: 5,
				servedModel: null,
				reason: "http 500",
			},
			"zai-glm-5.3-flash": {
				status: "down",
				latencyMs: 5,
				servedModel: null,
				reason: "http 500",
			},
			"glm-4.5-air": {
				status: "up",
				latencyMs: 42,
				servedModel: "glm-4.5-air",
				reason: null,
			},
		};
		const summary = await sweepOnce({
			store: db,
			resolveHubs: () => hubs,
			fetchCatalog: async (url) =>
				url.includes("nas")
					? ["glm-5.3-flash", "glm-4.5-air"]
					: ["zai-glm-5.3-flash", "glm-4.5-air"],
			probe: async (o) => verdicts[o.group],
		});
		expect(summary.hubs).toHaveLength(2);
		expect(summary.down).toEqual(["glm-5-3-flash"]);
		expect(summary.banked).toBe(2);
		const facts = readModelHealthFacts(db);
		expect(facts.get("model.health.glm-4-5-air")?.status).toBe("up");
		expect(facts.get("model.health.glm-5-3-flash")?.status).toBe("down");
		// the report/board surface reads the same facts
		expect(downModelGroups(db)).toEqual(["glm-5-3-flash"]);
	});

	test("W1302.6 audit: a re-pin rewrites the REQUEST — serving the old pin still mismatches", () => {
		// re-pin moved the request to glm-4.5-air; a leg serving the DEAD
		// glm-5.3-flash name must still grade mismatch (re-pin ≠ alias).
		expect(wireModelMismatch("glm-4.5-air", "glm-5.3-flash")).toBe(true);
		// serving the new pin (or its hub-prefixed spell) matches
		expect(wireModelMismatch("glm-4.5-air", "zai-glm-4.5-air")).toBe(false);
	});
});
