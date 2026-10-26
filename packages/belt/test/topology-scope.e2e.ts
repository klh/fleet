// W858.7.33 slice-4 unit tests: the enterprise scope engine — policy parse,
// stamp verify, snapshot filtering BEFORE aggregation, the detail gate — plus
// the hub-overview team/project filters and deep-link hash helpers.
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_AUTHORITY,
	detailAccess,
	FULL_AUTHORITY,
	mintTopologyStamp,
	parseTopologyPolicy,
	resolveTopologyAuthority,
	scopeTopologySnapshot,
	verifyTopologyStamp,
	loadTopologyPolicy,
} from "../bin/topology-scope.ts";
import {
	hubOverview,
	parseTopologyHash,
	serializeTopologyHash,
} from "../bin/dashboard-topology-hubs-model.js";
import { observedGraph } from "../bin/dashboard-topology-model.js";

const SECRET = Buffer.from("w858-slice-4-test-secret");
const NOW = Date.parse("2026-10-24T12:00:00Z");
const at = (secondsAgo: number) =>
	new Date(NOW - secondsAgo * 1000).toISOString();

const POLICY = parseTopologyPolicy(
	JSON.stringify({
		hubs: {
			"team-hub": { tenant: "acme", teams: ["edge"], projects: ["atlas"] },
			"dev-hub": { tenant: "globex", teams: [], projects: [] },
		},
		stampSecretPath: null,
		trustedStampers: ["127.0.0.1"],
	}),
);

const reqWith = (headers: Record<string, string>): Request =>
	new Request("http://127.0.0.1:7791/api/network", { headers });

const SECRET_DIR = mkdtempSync(join(tmpdir(), "w858-scope-"));
const secretPath = join(SECRET_DIR, "stamp.key");
writeFileSync(secretPath, SECRET);

const edge = (from: string, to: string, requests: number) => ({
	id: `edge:${from}->${to}`,
	from,
	to,
	requests,
	failed: 0,
	active: 0,
	inputTokens: null,
	outputTokens: null,
	coverage: { source: "projection", usageBearingRequests: 0 },
	lastSeenAt: at(30),
	evidence: "trace",
});

const PROVIDER = {
	id: "target:provider:api.z.ai:443",
	kind: "provider",
	host: "api.z.ai",
	port: 443,
	lastSeenAt: at(30),
};

function snapshot() {
	return {
		ok: true,
		schemaVersion: 1,
		observedAt: at(5),
		windowStart: at(900),
		hubs: [
			{ id: "hub:team-hub", name: "team-hub", lastSeenAt: at(30) },
			{ id: "hub:dev-hub", name: "dev-hub", lastSeenAt: at(30) },
			{ id: "hub:shared", name: "shared", lastSeenAt: at(30) },
		],
		targets: [PROVIDER],
		edges: [
			edge("hub:team-hub", "hub:shared", 3),
			edge("hub:dev-hub", PROVIDER.id, 7),
			edge("hub:team-hub", PROVIDER.id, 4),
		],
		traces: [
			{
				id: "a".repeat(32),
				hops: ["team-hub", "shared"],
				complete: true,
				lastSeenAt: at(30),
			},
			{
				id: "b".repeat(32),
				hops: ["dev-hub", "shared"],
				complete: false,
				lastSeenAt: at(40),
			},
		],
		totals: {
			requests: 14,
			failed: 1,
			active: 0,
			inputTokens: 100,
			outputTokens: 200,
		},
		coverage: { projectionAvailable: true, ledgerAvailable: false },
	};
}

test.describe("topology scope policy + authority", () => {
	test("policy absent = inert (no BELT_TOPOLOGY_POLICY → null) @unit", () => {
		expect(loadTopologyPolicy({})).toBeNull();
		expect(loadTopologyPolicy({ BELT_TOPOLOGY_POLICY: "" })).toBeNull();
	});

	test("configured-but-broken policy throws (startup fatal, fail closed) @unit", () => {
		expect(() => parseTopologyPolicy("not json")).toThrow();
		expect(() =>
			parseTopologyPolicy(JSON.stringify({ hubs: { h: {} } })),
		).toThrow(/tenant/);
		expect(() =>
			parseTopologyPolicy(JSON.stringify({ hubs: { h: { teams: ["x"] } } })),
		).toThrow();
	});

	test("stamp round-trips and tampered/stale-peer stamps reject @unit", () => {
		const withSecret = { ...POLICY, stampSecretPath: secretPath };
		const stamp = mintTopologyStamp(
			{
				tenant: "acme",
				teams: ["edge"],
				projects: ["atlas"],
				scopes: ["topology.models"],
			},
			SECRET,
		);
		expect(verifyTopologyStamp(stamp, withSecret, "127.0.0.1")).toBe(true);
		expect(verifyTopologyStamp(stamp, withSecret, "192.0.2.9")).toBe(false);
		const forged = mintTopologyStamp(
			{ tenant: "acme", teams: ["edge"], scopes: ["topology.models"] },
			Buffer.from("wrong-secret"),
		);
		expect(verifyTopologyStamp(forged, withSecret, "127.0.0.1")).toBe(false);
		expect(verifyTopologyStamp(`${stamp}x`, withSecret, "127.0.0.1")).toBe(
			false,
		);
	});

	test("resolve: policy absent → FULL; no stamp → summaries-only DEFAULT @unit", () => {
		expect(resolveTopologyAuthority(reqWith({}), null, "127.0.0.1")).toBe(
			FULL_AUTHORITY,
		);
		const a = resolveTopologyAuthority(reqWith({}), POLICY, "127.0.0.1");
		expect(a.full).toBe(false);
		expect(a.scopes).toEqual([]);
		const stamped = resolveTopologyAuthority(
			reqWith({
				"x-klh-topology-authority": mintTopologyStamp(
					{
						tenant: "acme",
						teams: ["edge"],
						projects: ["atlas"],
						scopes: ["topology.models"],
					},
					SECRET,
				),
			}),
			{ ...POLICY, stampSecretPath: secretPath },
			"127.0.0.1",
		);
		expect(stamped.tenant).toBe("acme");
		expect(stamped.scopes).toEqual(["topology.models"]);
	});
});

test.describe("scopeTopologySnapshot", () => {
	test("inert authority returns the snapshot untouched (identity) @unit", () => {
		const snap = snapshot();
		const out = scopeTopologySnapshot(snap, FULL_AUTHORITY, POLICY);
		expect(out.snapshot).toBe(snap);
		expect(out.dropped).toEqual({
			hubs: 0,
			targets: 0,
			edges: 0,
			traces: 0,
		});
	});

	test("summaries-only viewer: foreign hubs, their edges/targets/traces drop; totals null; coverage flags @unit", () => {
		const out = scopeTopologySnapshot(snapshot(), DEFAULT_AUTHORITY, POLICY);
		expect(out.snapshot.hubs.map((hub) => hub.name)).toEqual(["shared"]);
		expect(out.snapshot.targets).toEqual([]);
		expect(out.snapshot.edges).toEqual([]);
		expect(out.snapshot.traces).toEqual([]);
		expect(out.snapshot.totals).toEqual({
			requests: null,
			failed: null,
			active: null,
			inputTokens: null,
			outputTokens: null,
		});
		expect(out.snapshot.coverage).toEqual({
			projectionAvailable: true,
			ledgerAvailable: false,
			scopeFiltering: "active",
			scopeDropped: { hubs: 2, targets: 1, edges: 3, traces: 2 },
		});
	});

	test("member viewer sees own-tenant hub with attribution attached; foreign hub drops @unit", () => {
		const authority = resolveTopologyAuthority(
			reqWith({
				"x-klh-topology-authority": mintTopologyStamp(
					{
						tenant: "acme",
						teams: ["edge"],
						projects: ["atlas"],
						scopes: ["topology.models", "topology.lanes"],
					},
					SECRET,
				),
			}),
			{ ...POLICY, stampSecretPath: secretPath },
			"127.0.0.1",
		);
		const out = scopeTopologySnapshot(snapshot(), authority, POLICY);
		expect(out.snapshot.hubs.map((hub) => hub.name).sort()).toEqual([
			"shared",
			"team-hub",
		]);
		const teamHub = out.snapshot.hubs.find((hub) => hub.name === "team-hub");
		expect(teamHub.tenant).toBe("acme");
		expect(teamHub.teams).toEqual(["edge"]);
		expect(teamHub.projects).toEqual(["atlas"]);
		// team-hub edges survive; the dev-hub→provider edge drops with its hub
		expect(out.snapshot.edges.map((edge) => edge.id)).toEqual([
			"edge:hub:team-hub->hub:shared",
			"edge:hub:team-hub->target:provider:api.z.ai:443",
		]);
		// provider target survives on team-hub's edge; traces touching dev-hub drop
		expect(out.snapshot.targets.map((target) => target.id)).toEqual([
			PROVIDER.id,
		]);
		expect(out.snapshot.traces.map((trace) => trace.id[0])).toEqual(["a"]);
	});

	test("cross-tenant stamp (globex) cannot see the acme hub @unit", () => {
		const authority = resolveTopologyAuthority(
			reqWith({
				"x-klh-topology-authority": mintTopologyStamp(
					{
						tenant: "globex",
						teams: [],
						projects: [],
						scopes: ["topology.models", "topology.lanes"],
					},
					SECRET,
				),
			}),
			{ ...POLICY, stampSecretPath: secretPath },
			"127.0.0.1",
		);
		const out = scopeTopologySnapshot(snapshot(), authority, POLICY);
		expect(out.snapshot.hubs.map((hub) => hub.name)).toEqual([
			"dev-hub",
			"shared",
		]);
	});
});

test.describe("detailAccess", () => {
	test("no scope → fixed-shape denial; models/lanes scopes pass; inert full @unit", () => {
		const models = detailAccess(DEFAULT_AUTHORITY, "topology.models");
		expect(models.ok).toBe(false);
		expect(models.status).toBe(403);
		expect(models.code).toBe("topology.scope_denied");
		expect(models.why).toContain("topology.models");
		expect(detailAccess(DEFAULT_AUTHORITY, "topology.lanes").ok).toBe(false);
		const viewer = { ...DEFAULT_AUTHORITY, scopes: ["topology.models"] };
		expect(detailAccess(viewer, "topology.models").ok).toBe(true);
		expect(detailAccess(viewer, "topology.lanes").ok).toBe(false);
		expect(detailAccess(FULL_AUTHORITY, "topology.models").ok).toBe(true);
		expect(detailAccess(FULL_AUTHORITY, "topology.lanes").ok).toBe(true);
	});
});

test.describe("hubOverview team/project filters", () => {
	const buildGraph = () => {
		const base = snapshot();
		// scoped snapshots attach attribution to permitted hubs; observedGraph
		// must carry it through to the aggregation
		base.hubs[0].tenant = "acme";
		base.hubs[0].teams = ["edge"];
		base.hubs[0].projects = ["atlas"];
		return observedGraph({ topology: base }, NOW);
	};

	test("team filter narrows hubs and drops links outside the filter @unit", () => {
		const graph = buildGraph();
		const view = hubOverview(graph, { now: NOW, team: "edge" });
		expect(view.hubs.map((hub) => hub.label)).toEqual(["team-hub"]);
		expect(view.links).toEqual([]);
		expect(view.estate.hubs).toBe(1);
	});

	test("no filter = every hub (scoped data is already authority-filtered) @unit", () => {
		const view = hubOverview(buildGraph(), { now: NOW });
		expect(view.hubs).toHaveLength(3);
	});

	test("project filter matches hub attribution @unit", () => {
		const view = hubOverview(buildGraph(), { now: NOW, project: "atlas" });
		expect(view.hubs.map((hub) => hub.label)).toEqual(["team-hub"]);
	});
});

test.describe("deep-link hash", () => {
	test("round-trips layer/window/query/team/project/hub @unit", () => {
		const state = {
			layer: "connected",
			window: "1m",
			q: "glm",
			team: "edge",
			project: "atlas",
			hub: "hub:team-hub",
		};
		expect(parseTopologyHash(serializeTopologyHash(state))).toEqual(state);
	});

	test("unknown keys drop; empty state serializes to no hash @unit", () => {
		expect(parseTopologyHash("#layer=observed&evil=<script>")).toEqual({
			layer: "observed",
		});
		expect(parseTopologyHash("")).toEqual({});
		expect(parseTopologyHash(undefined)).toEqual({});
		expect(serializeTopologyHash({})).toBe("");
	});
});
