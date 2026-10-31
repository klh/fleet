// W993 — hub↔provider discovery: host-derived provider resolution (hubs.ts)
// and hub→provider links (dashboard-topology-model.js) without declared
// provider intents. Hosts resolve only unambiguous cloud providers; local
// hosts and ambiguous pairs never become edges.
import { expect, test } from "@playwright/test";
import { buildTopology } from "../bin/dashboard-topology-model.js";
import { providerObservationsFromRequests } from "../bin/hubs.ts";

const now = Date.parse("2026-10-23T10:00:00Z");
const LAST_AT = new Date(now).toISOString();

const HUB_ROUTE = {
	name: "desktop",
	models: ["claude-sonnet-5-5"],
	routeCount: 1,
	unresolvedRoutes: [],
	routesByModel: {},
	providerIntents: [] as string[],
	providerHosts: ["api.githubcopilot.com"],
	providerHostsByModel: {
		"claude-sonnet-5-5": ["api.githubcopilot.com"],
	},
	targetPortsByModel: {},
	providerModelIds: {},
};

const inferenceRow = (model: string) => ({
	ts: LAST_AT,
	target_model: model,
	traffic_kind: "inference",
	ok: 0,
	status: 429,
});

const HUB_TARGET = {
	kind: "hub",
	name: "desktop",
	state: "up",
	port: 4111,
};

const SUPERVISOR = {
	observation: null,
	targets: [HUB_TARGET],
};

const W993_CONTEXT = {
	hubProviderObservations: [
		{
			hub: "DESKTOP",
			provider: "copilot",
			successes15: 3,
			failures15: 1,
			lastStatus: 429,
			lastAt: LAST_AT,
		},
	],
	hubRoutes: [HUB_ROUTE],
};

test("ledger observation attaches and draws an observed link without declared intents @unit", () => {
	const model = buildTopology(
		{},
		{ ts: new Date(now).toISOString(), rows: [], routes: [] },
		SUPERVISOR,
		now,
		null,
		null,
		W993_CONTEXT,
	);
	// W993.4 semantics (main's evolution): the observed link itself renders
	// for any fresh ledger row; the provider indicator stays intent-gated.
	const copilot = model.providers.find((p) => p.key === "copilot");
	expect(copilot?.hubRequest).toBeUndefined();
	expect(model.hubs[0]?.providerKeys).toEqual(["copilot"]);
	expect(model.hubProviderLinks).toEqual([
		{
			hub: "desktop",
			provider: "copilot",
			evidence: "observed",
			requests15: 4,
			successes15: 3,
			failures15: 1,
			lastStatus: 429,
			source: "hub Buckle ledger",
			lastSeen: LAST_AT,
		},
	]);
});

test("configured-only pairing stays dashed with no counts @unit", () => {
	const model = buildTopology(
		{},
		{ ts: new Date(now).toISOString(), rows: [], routes: [] },
		SUPERVISOR,
		now,
		null,
		null,
		{ hubProviderObservations: [], hubRoutes: [HUB_ROUTE] },
	);
	const link = model.links.find(
		(l) => l.from === "hub:desktop" && l.target === "provider:copilot",
	);
	expect(link?.evidence).toBe("configured");
	expect(link?.requests15).toBeNull();
	expect(link?.failures15).toBeNull();
	expect(link?.lastSeen).toBeUndefined();
});

test("host-derived resolution counts ledger traffic without declared intents @unit", () => {
	const rows = providerObservationsFromRequests(
		"DESKTOP",
		HUB_ROUTE,
		[inferenceRow("claude-sonnet-5-5")],
		now,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.provider).toBe("copilot");
	expect(rows[0]?.failures15).toBe(1);
	expect(rows[0]?.lastStatus).toBe(429);
});

test("ambiguous cloud hosts refuse to resolve a provider @unit", () => {
	const routes = {
		...HUB_ROUTE,
		models: ["m"],
		providerHosts: ["api.githubcopilot.com", "api.z.ai"],
		providerHostsByModel: { m: ["api.githubcopilot.com", "api.z.ai"] },
	};
	const rows = providerObservationsFromRequests(
		"DESKTOP",
		routes,
		[inferenceRow("m")],
		now,
	);
	expect(rows).toHaveLength(0);
});

test("local hosts never become provider edges @unit", () => {
	const routes = {
		...HUB_ROUTE,
		models: ["m"],
		providerHosts: ["127.0.0.1"],
		providerHostsByModel: { m: ["127.0.0.1"] },
	};
	const rows = providerObservationsFromRequests(
		"DESKTOP",
		routes,
		[inferenceRow("m")],
		now,
	);
	expect(rows.map((row) => row.provider)).toEqual([]);
});

test("declared intents stay a fallback pairing source @unit", () => {
	const routes = {
		...HUB_ROUTE,
		name: "nas",
		models: ["m"],
		routesByModel: { m: ["openrouter/x"] },
		providerIntents: ["openrouter"],
		providerHosts: [],
		providerHostsByModel: {},
	};
	const rows = providerObservationsFromRequests(
		"NAS",
		routes,
		[inferenceRow("m")],
		now,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.provider).toBe("openrouter");
});
