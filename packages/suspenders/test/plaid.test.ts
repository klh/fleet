// test/plaid.test.ts — W911: the bounded plaid posture. Owner arithmetic
// (coord #46919): two per-provider pools 6–8 each, +2 global overflow,
// hard cap 18. Covers: posture fail-safe parse, width, route-table
// honesty invariant (ikea-* ⇒ copilot), plan phases (baseline fair-fill,
// stretch, overflow, cap, walled pool contributes zero), assignment
// (least-loaded + ordinal ties + walled exclusion), facts roundtrip,
// status shape.

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import type { PlaidRoute } from "../hooks/lib/plaid.ts";
import {
	fetchModelCatalog,
	mergePlaidHealth,
	PLAID,
	PLAID_ROUTES,
	parsePosture,
	plaidAssign,
	plaidGate,
	plaidHealth,
	plaidModelHealth,
	plaidPlan,
	plaidRoutes,
	plaidStatus,
	postureFactOf,
	postureWidth,
	readPosture,
	recordLaneRoute,
	recordPostureFact,
	routeLoadOf,
	setPlaidRouteSource,
	writePosture,
} from "../hooks/lib/plaid.ts";

const dbs: Database[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	setPlaidRouteSource(null as never);
});

const store = (): GovernorStore => {
	const db = new Database(":memory:");
	dbs.push(db);
	db.run(
		"CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER DEFAULT 1, ts INTEGER)",
	);
	return db as unknown as GovernorStore;
};

test("posture parse fail-safe: junk → steady, case tolerant, file roundtrip", () => {
	expect(parsePosture(" PLAID ")).toBe("plaid");
	expect(parsePosture("steady")).toBe("steady");
	expect(parsePosture("junk")).toBeNull();
	expect(parsePosture(undefined)).toBeNull();
	const d = mkdtempSync(join(tmpdir(), "w911-post-"));
	dirs.push(d);
	expect(readPosture(d)).toBe("steady"); // absent file
	writePosture(d, "plaid");
	expect(readPosture(d)).toBe("plaid");
});

test("width: steady rides --target; plaid rides the hard cap 18", () => {
	expect(postureWidth("steady", 6)).toBe(6);
	expect(postureWidth("steady", 4)).toBe(4);
	expect(postureWidth("plaid", 6)).toBe(PLAID.hardCap);
});

test("route table: owner defaults, honesty invariant, junk → defaults", () => {
	expect(plaidRoutes().map((r) => r.name)).toEqual([
		"ikea-sonnet",
		"glm-5.3-flash",
		"codex-personal",
	]);
	// W989 truthfulness: the codex executor rides the personal Codex CLI
	// seat — no ikea-* name, no pool provider (never pool capacity)
	expect(plaidRoutes().at(-1)?.provider).toBeNull();
	// the honesty law: an ikea-* name on a non-copilot provider = junk row
	expect(
		plaidRoutes([{ name: "ikea-x", executor: "claude", provider: "zai" }]),
	).toBe(PLAID_ROUTES);
	expect(plaidRoutes("not an array")).toBe(PLAID_ROUTES);
	expect(plaidRoutes([])).toBe(PLAID_ROUTES);
});

const healthy = (): Map<string, string | null> => {
	const m = new Map<string, string | null>();
	for (const r of PLAID_ROUTES) m.set(r.name, null);
	return m;
};

const healthy2 = (routes: PlaidRoute[]): Map<string, string | null> => {
	const m = new Map<string, string | null>();
	for (const r of routes) m.set(r.name, null);
	return m;
};

test("plan: baseline fair-fill — emptiest pool first, both minimums filled", () => {
	const plan = plaidPlan(PLAID_ROUTES, healthy(), new Map(), 0);
	expect(plan).toEqual({
		open: true,
		provider: "copilot",
		phase: "baseline",
		reason: null,
	});
});

test("plan: baseline before stretch — a pool under 6 outranks one at 6", () => {
	const live = new Map<string, number>([
		["copilot", 6],
		["zai", 3],
	]);
	const plan = plaidPlan(PLAID_ROUTES, healthy(), live, 9);
	expect(plan.phase).toBe("baseline");
	expect(plan.provider).toBe("zai");
});

test("plan: stretch to 8 per pool once both baselines are full", () => {
	const live = new Map<string, number>([
		["copilot", 6],
		["zai", 6],
	]);
	const plan = plaidPlan(PLAID_ROUTES, healthy(), live, 12);
	expect(plan.phase).toBe("stretch");
	expect(plan.provider).toBe("copilot"); // tie → table order
});

test("plan: overflow only past two full pools, capped at +2", () => {
	const full = new Map<string, number>([
		["copilot", 8],
		["zai", 8],
	]);
	const over = plaidPlan(PLAID_ROUTES, healthy(), full, 16);
	expect(over.phase).toBe("overflow");
	expect(over.provider).toBe("copilot");
	// pool overflow ceiling: 10 in a pool = 8 pool + 2 overflow share
	const atCeiling = new Map<string, number>([
		["copilot", 10],
		["zai", 8],
	]);
	const over2 = plaidPlan(PLAID_ROUTES, healthy(), atCeiling, 18);
	expect(over2.open).toBe(false);
	expect(over2.reason).toBe("plaid at capacity: 18/18 lanes live");
});

test("plan: walled pool contributes zero — the healthy pool rides its own phases", () => {
	const health = healthy();
	health.set("ikea-sonnet", "quota wall");
	// copilot fully walled; zai alone healthy → its OWN baseline, never a
	// copilot slot — the shortfall shows in status baselineOpen, not here
	const plan = plaidPlan(PLAID_ROUTES, health, new Map(), 0);
	expect(plan.open).toBe(true);
	expect(plan.provider).toBe("zai");
	expect(plan.phase).toBe("baseline");
});

test("plan: all pools walled → dispatch paused with the loud reason", () => {
	const dead = healthy();
	for (const r of PLAID_ROUTES) dead.set(r.name, "quota wall");
	const paused = plaidPlan(PLAID_ROUTES, dead, new Map(), 0);
	expect(paused.open).toBe(false);
	expect(paused.reason).toBe(
		"plaid: no healthy route in any pool — dispatch paused",
	);
});

test("assign: least-loaded route of the pool, ordinal-balanced ties", () => {
	// a two-route copilot pool (machine-config shape) exercises the tiebreak
	const two: PlaidRoute[] = [
		...PLAID_ROUTES.filter((r) => r.provider === "copilot"),
		{
			name: "ikea-haiku",
			label: "IKEA Copilot Haiku",
			executor: "claude",
			model: "claude-haiku-4-5",
			provider: "copilot",
		},
	];
	const load = new Map<string, number>([
		["ikea-sonnet", 1],
		["ikea-haiku", 2],
	]);
	const first = plaidAssign(two, healthy2(two), load, "copilot", 0);
	expect(first.route.name).toBe("ikea-sonnet");
	// two healthy tied routes, ordinal 1 → round-robin to the second
	const tied = plaidAssign(two, healthy2(two), new Map(), "copilot", 1);
	expect(tied.route.name).toBe("ikea-haiku");
	// the walled route never takes a lane — its share stays in-pool
	const walled = healthy2(two);
	walled.set("ikea-haiku", "quota wall");
	const only = plaidAssign(two, walled, new Map(), "copilot", 1);
	expect(only.route.name).toBe("ikea-sonnet");
	expect(only.phase).toBeNull();
});

test("health: quota penalty outranks the binary probe, per-pool walling", () => {
	const quota = new Map([["copilot", "credit headroom low"]]);
	const health = plaidHealth(quota);
	expect(health.get("ikea-sonnet")).toBe("credit headroom low");
	// glm rides claude (present on PATH); zai unpunished → healthy
	expect(health.get("glm-5.3-flash")).toBeNull();
	// the personal codex seat is bin-probed only (no provider to punish)
	expect(["executor binary codex not on PATH", null]).toContain(
		health.get("codex-personal"),
	);
});

test("model probe: a pin the front can't serve walls the route; no evidence never demotes", () => {
	const catalog = ["claude-sonnet-5", "glm-5.3-flash"];
	const ok = plaidModelHealth(PLAID_ROUTES, catalog);
	expect(ok.get("ikea-sonnet")).toBeNull();
	expect(ok.get("glm-5.3-flash")).toBeNull();
	// unpinned routes are exempt (no model to verify)
	expect(ok.get("codex-personal")).toBeNull();
	const missing = plaidModelHealth(PLAID_ROUTES, ["glm-5.3-flash"]);
	expect(missing.get("ikea-sonnet")).toBe(
		"model claude-sonnet-5 not served at the buckle front",
	);
	// no evidence (front unreachable/odd shape) — fail-open doctrine
	const none = plaidModelHealth(PLAID_ROUTES, null);
	expect(none.get("ikea-sonnet")).toBeNull();
	// the no-belt fetch short-circuits without touching the network
	expect(fetchModelCatalog(null)).resolves.toBeNull();
});

test("gate: model-probe walling re-routes the pool plan; quota outranks the probe", () => {
	const db = store();
	// probe alone: the copilot pin unserved → zai takes the baseline
	const g = plaidGate(
		db,
		[],
		new Map(),
		plaidModelHealth(PLAID_ROUTES, ["glm-5.3-flash"]),
	);
	expect(g.plan.open).toBe(true);
	expect(g.plan.provider).toBe("zai");
	// merge: first non-null reason wins (quota outranks the probe)
	const merged = mergePlaidHealth(
		new Map([["ikea-sonnet", "credit headroom low"]]),
		new Map([["ikea-sonnet", "model claude-sonnet-5 not served"]]),
	);
	expect(merged.get("ikea-sonnet")).toBe("credit headroom low");
	// null probe = pass-through of the quota-only map
	expect(mergePlaidHealth(new Map([["k", "r"]]), null).get("k")).toBe("r");
});

test("route-table override: machine config flows through health", () => {
	setPlaidRouteSource(() => [
		{
			name: "custom-x",
			label: "Custom",
			executor: "claude",
			model: "some-model",
			provider: "zai",
		},
	]);
	const health = plaidHealth(new Map());
	expect(health.has("custom-x")).toBe(true);
	expect(health.has("ikea-codex")).toBe(false);
});

test("facts: lane route + posture roundtrip, dead lanes never count", () => {
	const db = store();
	recordLaneRoute(db, "s1", "glm-5.3-flash");
	recordLaneRoute(db, "s2", "glm-5.3-flash");
	recordLaneRoute(db, "s3", "ikea-sonnet");
	// s2 is dead — its stale fact must not count
	expect(routeLoadOf(db, ["s1", "s3"]).get("glm-5.3-flash")).toBe(1);
	expect(routeLoadOf(db, ["s1", "s3"]).get("ikea-sonnet")).toBe(1);
	recordPostureFact(db, "plaid");
	expect(postureFactOf(db)).toBe("plaid");
	db.query("UPDATE facts SET value = 'junk' WHERE key = 'plaid.posture'").run();
	expect(postureFactOf(db)).toBe("steady"); // fail-safe narrow
});

test("status: UI-agreement shape — pools, baselineOpen, overflow, views", () => {
	const db = store();
	recordPostureFact(db, "plaid");
	recordLaneRoute(db, "s1", "ikea-sonnet");
	recordLaneRoute(db, "s2", "glm-5.3-flash");
	const st = plaidStatus(db, ["s1", "s2", "s3-dead"]);
	expect(st.posture).toBe("plaid");
	expect(st.width).toBe(18);
	expect(st.live.copilot).toBe(1);
	expect(st.live.zai).toBe(1);
	expect(st.baselineOpen.copilot).toBe(5);
	expect(st.baselineOpen.zai).toBe(5);
	expect(st.overflow.used).toBe(0);
	expect(st.fallback).toBe(false);
	const sonnet = st.routes.find((r) => r.name === "ikea-sonnet");
	expect(sonnet?.lanes).toBe(1);
});
