// W993 — hub↔provider discovery: host-derived provider resolution (hubs.ts)
// and hub→provider links (dashboard-topology-model.js) without declared
// provider intents. Hosts resolve only unambiguous cloud providers; local
// hosts and ambiguous pairs never become edges.
import { describe, expect, test } from "bun:test";
import { providerObservationsFromRequests } from "../bin/hubs.ts";
import { buildTopology } from "../bin/dashboard-topology-model.js";

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

describe("W993 hub→provider discovery", () => {
	test("ledger observation attaches and draws an observed link without declared intents", () => {
		const model = buildTopology(
			{},
			{ ts: new Date(now).toISOString(), rows: [], routes: [] },
			SUPERVISOR,
			now,
			null,
			null,
			W993_CONTEXT,
		);
		const copilot = model.providers.find((p) => p.key === "copilot");
		expect(copilot?.hubRequest?.successes15).toBe(3);
		expect(copilot?.hubRequest?.failures15).toBe(1);
		expect(model.hubs[0]?.providerKeys).toEqual(["copilot"]);
		const link = model.links.find(
			(l) => l.from === "hub:desktop" && l.target === "provider:copilot",
		);
		expect(link?.evidence).toBe("observed");
		expect(link?.requests15).toBe(4);
		expect(link?.failures15).toBe(1);
		expect(link?.lastSeen).toBe(now);
	});

	test("configured-only pairing stays dashed with no counts", () => {
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
});

describe("W993 provider resolution (hubs.ts)", () => {
	test("host-derived resolution counts ledger traffic without declared intents", () => {
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

	test("ambiguous cloud hosts refuse to resolve a provider", () => {
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

	test("local hosts never become provider edges", () => {
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

	test("declared intents stay a fallback pairing source", () => {
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
});
