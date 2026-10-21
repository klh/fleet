// test/plaid.test.ts — the uncapped plaid posture. Covers posture parse,
// provider fairness, quota walling, route-table honesty (ikea-* ⇒ copilot),
// route assignment and status.

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
	PLAID_ROUTES,
	parsePosture,
	plaidAssign,
	plaidDispatch,
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

test("width: steady rides --target; plaid has no fixed ceiling", () => {
	expect(postureWidth("steady", 6)).toBe(6);
	expect(postureWidth("steady", 4)).toBe(4);
	expect(postureWidth("plaid", 6)).toBeNull();
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
	const plan = plaidPlan(PLAID_ROUTES, healthy(), new Map());
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
	const plan = plaidPlan(PLAID_ROUTES, healthy(), live);
	expect(plan.phase).toBe("baseline");
	expect(plan.provider).toBe("zai");
});

test("plan: balanced growth after both baselines are full", () => {
	const live = new Map<string, number>([
		["copilot", 6],
		["zai", 6],
	]);
	const plan = plaidPlan(PLAID_ROUTES, healthy(), live);
	expect(plan.phase).toBe("growth");
	expect(plan.provider).toBe("copilot"); // tie → table order
});

test("plan: 40 eligible lanes grow fairly with no fixed provider or global ceiling", () => {
	const live = new Map<string, number>();
	for (let n = 0; n < 40; n++) {
		const plan = plaidPlan(PLAID_ROUTES, healthy(), live);
		expect(plan.open).toBe(true);
		const provider = plan.provider as "copilot" | "zai";
		live.set(provider, (live.get(provider) ?? 0) + 1);
	}
	expect(live.get("copilot")).toBe(20);
	expect(live.get("zai")).toBe(20);
	expect(plaidPlan(PLAID_ROUTES, healthy(), live).open).toBe(true);
});

test("plan: walled pool contributes zero — the healthy pool rides its own phases", () => {
	const health = healthy();
	health.set("ikea-sonnet", "quota wall");
	// copilot fully walled; zai alone healthy → its OWN baseline, never a
	// copilot slot — the shortfall shows in status baselineOpen, not here
	const plan = plaidPlan(PLAID_ROUTES, health, new Map());
	expect(plan.open).toBe(true);
	expect(plan.provider).toBe("zai");
	expect(plan.phase).toBe("baseline");
});

test("plan: all pools walled → dispatch paused with the loud reason", () => {
	const dead = healthy();
	for (const r of PLAID_ROUTES.filter((route) => route.provider))
		dead.set(r.name, "quota wall");
	const paused = plaidPlan(PLAID_ROUTES, dead, new Map());
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

test("model probe: a pin the front can't serve walls the route; unavailable ≠ empty", () => {
	const catalog = ["claude-sonnet-5", "glm-5.3-flash"];
	const ok = plaidModelHealth(PLAID_ROUTES, catalog);
	expect(ok?.get("ikea-sonnet")).toBeNull();
	expect(ok?.get("glm-5.3-flash")).toBeNull();
	// unpinned routes are exempt (no model to verify)
	expect(ok?.get("codex-personal")).toBeNull();
	const missing = plaidModelHealth(PLAID_ROUTES, ["glm-5.3-flash"]);
	expect(missing?.get("ikea-sonnet")).toBe(
		"model claude-sonnet-5 not served at the buckle front",
	);
	// W1102.1 fail-closed: catalog UNAVAILABLE → null (plaid holds on it),
	// a reachable EMPTY catalog is valid evidence (walls every pinned route)
	expect(plaidModelHealth(PLAID_ROUTES, null)).toBeNull();
	const empty = plaidModelHealth(PLAID_ROUTES, []);
	expect(empty?.get("ikea-sonnet")).toContain("not served");
	// the no-belt fetch short-circuits without touching the network
	expect(fetchModelCatalog(null)).resolves.toBeNull();
});

test("gate: model-probe walling re-routes the pool plan; quota outranks the probe", () => {
	const db = store();
	// W1102.1 fail-closed: an UNAVAILABLE catalog closes the plan outright
	const un = plaidGate(db, [], new Map(), null);
	expect(un.plan.open).toBe(false);
	expect(un.plan.reason).toContain("catalog unavailable");
	// the dispatch override holds too (pinned or pooled)
	expect(
		plaidDispatch({
			store: db,
			sids: [],
			quota: new Map(),
			ordinal: 0,
			hub: null,
			modelHealth: null,
		}).skip,
	).toContain("catalog unavailable");
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

test("explicit route pin keeps GLM under plaid and removes model fallbacks", () => {
	const db = store();
	const pinned = plaidDispatch({
		store: db,
		sids: [],
		quota: new Map(),
		ordinal: 0,
		hub: null,
		routePin: "glm-5.3-flash",
	});
	expect(pinned.routeName).toBe("glm-5.3-flash");
	expect(pinned.pick.model).toBe("glm-5.3-flash");
	expect(pinned.pick.fallbackModels).toEqual([]);
	expect(
		plaidDispatch({
			store: db,
			sids: [],
			quota: new Map(),
			ordinal: 0,
			hub: null,
			routePin: "missing",
		}).skip,
	).toContain("missing");
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

test("status: UI-agreement shape exposes unbounded growth and current pool load", () => {
	const db = store();
	recordPostureFact(db, "plaid");
	recordLaneRoute(db, "s1", "ikea-sonnet");
	recordLaneRoute(db, "s2", "glm-5.3-flash");
	const st = plaidStatus(db, ["s1", "s2", "s3-dead"]);
	expect(st.posture).toBe("plaid");
	expect(st.width).toBeNull();
	expect(st.live.copilot).toBe(1);
	expect(st.live.zai).toBe(1);
	expect(st.baselineOpen.copilot).toBe(5);
	expect(st.baselineOpen.zai).toBe(5);
	expect(st.fallback).toBe(false);
	const sonnet = st.routes.find((r) => r.name === "ikea-sonnet");
	expect(sonnet?.lanes).toBe(1);
});
