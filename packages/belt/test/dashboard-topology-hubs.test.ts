// W858.7.31 slice-2 unit tests: hubOverview aggregation + hubOverviewLayout
// determinism (1/10/100 hubs, shuffled input order → same positions).
import { describe, expect, test } from "bun:test";
import {
	edgeFlow,
	edgeWidth,
	hubOverview,
	hubOverviewLayout,
	linkFlows,
} from "../bin/dashboard-topology-hubs-model.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

/** Minimal observedGraph-shaped fixture: hubs, endpoints, edges, traces. */
function graphFixture(hubs, edges, traces = []) {
	return {
		nodes: hubs.map((hub) => ({
			id: `hub:${hub}`,
			label: hub,
			kind: "hub",
			lastSeenAt: at(30),
		})),
		edges,
		traces,
		windowStart: at(900),
		observedAt: at(5),
	};
}

function hubEdge(from, to, extra = {}) {
	return {
		id: `edge:${from}->${to}`,
		from,
		to,
		requests: 0,
		failed: 0,
		active: null,
		inputTokens: null,
		outputTokens: null,
		coverage: null,
		lastSeenAt: at(30),
		evidence: "trace",
		...extra,
	};
}

describe("hubOverview", () => {
	test("returns null for a missing graph", () => {
		expect(hubOverview(null)).toBeNull();
	});

	test("aggregates endpoint traffic onto the forwarding hub and collapses it to counts", () => {
		const graph = graphFixture(
			["local"],
			[
				hubEdge("hub:local", "target:provider:api.z.ai:443", {
					requests: 7,
					failed: 1,
					inputTokens: 100,
					outputTokens: 200,
					coverage: { usageBearingRequests: 5 },
				}),
			],
		);
		// endpoint node must exist for the edge to survive
		graph.nodes.push({
			id: "target:provider:api.z.ai:443",
			label: "api.z.ai:443",
			kind: "endpoint",
			targetKind: "provider",
			lastSeenAt: at(30),
		});
		const view = hubOverview(graph, { now: NOW });
		expect(view).not.toBeNull();
		expect(view.hubs).toHaveLength(1);
		const local = view.hubs[0];
		expect(local.state).toBe("active");
		expect(local.requests).toBe(7);
		expect(local.failed).toBe(1);
		expect(local.endpoints.map((e) => e.label)).toEqual(["api.z.ai:443"]);
		expect(local.tokens).toEqual({
			input: 100,
			output: 200,
			usageBearing: 5,
		});
	});

	test("1m window drops stale hops the 15m window keeps", () => {
		const graph = graphFixture(
			["a", "b"],
			[hubEdge("hub:a", "hub:b", { requests: 3, lastSeenAt: at(120) })],
		);
		const fresh = hubOverview(graph, { now: NOW, windowMs: 900_000 });
		const minute = hubOverview(graph, { now: NOW, windowMs: 60_000 });
		expect(fresh.hubs).toHaveLength(2);
		expect(fresh.links).toHaveLength(1);
		expect(minute.links).toHaveLength(0);
		expect(minute.hubs.every((hub) => hub.state === "quiet")).toBe(true);
	});

	test("layers: observed hides ledger edges, configured adds planned hubs, connected keeps quiet hubs", () => {
		const graph = graphFixture(
			["a", "b"],
			[hubEdge("hub:a", "hub:b", { requests: 0, evidence: "ledger" })],
		);
		const observed = hubOverview(graph, { now: NOW, layer: "observed" });
		expect(observed.links).toHaveLength(0);
		expect(observed.hubs.every((hub) => hub.state === "quiet")).toBe(true);
		const connected = hubOverview(graph, { now: NOW, layer: "connected" });
		expect(connected.links).toHaveLength(1);
		const planned = hubOverview(graph, {
			now: NOW,
			layer: "configured",
			configuredHubs: [{ name: "ghost", state: "unknown" }],
		});
		expect(planned.hubs.map((hub) => hub.state)).toContain("planned");
		const ghost = planned.hubs.find((hub) => hub.id === "hub:ghost");
		expect(ghost.observed).toBe(false);
		expect(ghost.requests).toBe(0);
	});

	test("search matches hub labels and model names with via", () => {
		const graph = graphFixture(["a", "b"], []);
		const view = hubOverview(graph, {
			now: NOW,
			query: "glm",
			hubModels: { a: ["glm-5.3", "coder"], b: ["glm-5.3-flash"] },
		});
		const labels = view.search.map((hit) => `${hit.label} via ${hit.via}`);
		expect(labels).toEqual(["glm-5.3 via a", "glm-5.3-flash via b"]);
	});

	test("tokens: touching edges sum, no report stays null", () => {
		const graph = graphFixture(
			["a", "b"],
			[
				hubEdge("hub:a", "hub:b", {
					requests: 2,
					inputTokens: 10,
					outputTokens: null,
				}),
				hubEdge("hub:b", "hub:a", {
					requests: 1,
					inputTokens: null,
					outputTokens: 40,
				}),
			],
		);
		const view = hubOverview(graph, { now: NOW });
		const a = view.hubs.find((hub) => hub.id === "hub:a");
		expect(a.tokens.input).toBe(10);
		expect(a.tokens.output).toBe(40);
		const quiet = graphFixture(
			["a", "b"],
			[
				hubEdge("hub:a", "hub:b", {
					requests: 1,
					inputTokens: null,
					outputTokens: null,
				}),
			],
		);
		const quietView = hubOverview(quiet, { now: NOW });
		const qa = quietView.hubs.find((hub) => hub.id === "hub:a");
		expect(qa.tokens.input).toBeNull();
		expect(qa.tokens.output).toBeNull();
		expect(qa.tokens.usageBearing).toBe(0);
	});

	test("layout is deterministic at 1, 10 and 100 hubs under shuffled input order", () => {
		const pad = (i) => `hub-${String(i).padStart(2, "0")}`;
		const build = (count) => {
			const hubs = Array.from({ length: count }, (_, i) => ({
				id: `hub:${pad(i)}`,
				label: pad(i),
			}));
			const links = Array.from({ length: count - 1 }, (_, i) => ({
				from: `hub:${pad(i)}`,
				to: `hub:${pad(i + 1)}`,
			}));
			return { hubs, links };
		};
		const spots = (nodes) =>
			nodes.map((node) => `${node.id}@${node.x},${node.y}`).join("|");
		for (const count of [1, 10, 100]) {
			const { hubs, links } = build(count);
			const base = spots(hubOverviewLayout(hubs, links).nodes);
			for (let trial = 0; trial < 5; trial++) {
				const shuffled = [...hubs].sort(() => Math.random() - 0.5);
				expect(spots(hubOverviewLayout(shuffled, links).nodes)).toBe(base);
			}
		}
	});
});

describe("slice-3 flows", () => {
	const baseEdge = (extra = {}) => ({
		id: "edge:hub:a->hub:b",
		from: "hub:a",
		to: "hub:b",
		requests: 1,
		failed: 0,
		active: 0,
		inputTokens: null,
		outputTokens: null,
		coverage: null,
		lastSeenAt: at(30),
		evidence: "trace",
		...extra,
	});

	test("edgeWidth: 1-4px by hops/min, 1px baseline without measurements", () => {
		expect(edgeWidth(baseEdge({ requests: 0 }), 900_000)).toBe(1);
		expect(edgeWidth(baseEdge({ requests: 8 }), 900_000)).toBe(2);
		expect(edgeWidth(baseEdge({ requests: 45 }), 900_000)).toBe(3);
		expect(edgeWidth(baseEdge({ requests: 120 }), 900_000)).toBe(4);
		expect(edgeWidth(baseEdge({ requests: 8 }), 60_000)).toBe(4);
		expect(edgeWidth(null, 900_000)).toBe(1);
		expect(edgeWidth(baseEdge({ requests: null }), 900_000)).toBe(1);
	});
});

describe("slice-3 flows: edgeFlow", () => {
	const baseEdge = (extra = {}) => ({
		id: "edge:hub:a->hub:b",
		from: "hub:a",
		to: "hub:b",
		requests: 1,
		failed: 0,
		active: 0,
		inputTokens: null,
		outputTokens: null,
		coverage: null,
		lastSeenAt: at(30),
		evidence: "trace",
		...extra,
	});

	test("fresh observed hops animate with rate-bounded duration; stale/ledger never", () => {
		const fresh = edgeFlow(baseEdge({}), NOW, 900_000);
		expect(fresh).toEqual({ animate: true, durationS: 12 });
		const busy = edgeFlow(baseEdge({ requests: 90 }), NOW, 900_000);
		expect(busy).toEqual({ animate: true, durationS: 6 });
		const fastest = edgeFlow(baseEdge({ requests: 121 }), NOW, 900_000);
		expect(fastest).toEqual({ animate: true, durationS: 2.5 });
		expect(edgeFlow(baseEdge({ lastSeenAt: at(90) }), NOW, 900_000)).toEqual({
			animate: false,
		});
		expect(
			edgeFlow(baseEdge({ evidence: "ledger", requests: 5 }), NOW, 900_000),
		).toEqual({ animate: false });
		expect(edgeFlow(baseEdge({ requests: 0 }), NOW, 900_000)).toEqual({
			animate: false,
		});
		expect(edgeFlow(null, NOW, 900_000)).toEqual({ animate: false });
	});
});

describe("slice-3 flows: linkFlows", () => {
	const baseEdge = (extra = {}) => ({
		id: "edge:hub:a->hub:b",
		from: "hub:a",
		to: "hub:b",
		requests: 1,
		failed: 0,
		active: 0,
		inputTokens: null,
		outputTokens: null,
		coverage: null,
		lastSeenAt: at(30),
		evidence: "trace",
		...extra,
	});
	const trace = (id, hops, complete = true) => ({
		id,
		hops,
		complete,
		lastSeenAt: at(30),
	});

	test("consecutive trace hops join; ledger target edges never do", () => {
		const graph = graphFixture(
			["a", "b", "c"],
			[
				baseEdge({ id: "edge:hub:a->hub:b", from: "hub:a", to: "hub:b" }),
				baseEdge({ id: "edge:hub:b->hub:c", from: "hub:b", to: "hub:c" }),
				baseEdge({
					id: "edge:hub:c->target:p",
					from: "hub:c",
					to: "target:p",
					evidence: "ledger",
				}),
			],
			[trace("t2", ["a", "b"]), trace("t3", ["a", "b", "c"], false)],
		);
		const flows = linkFlows(graph, { now: NOW, windowMs: 900_000 });
		const ab = flows.get("edge:hub:a->hub:b");
		const bc = flows.get("edge:hub:b->hub:c");
		const cp = flows.get("edge:hub:c->target:p");
		expect(ab.traces.map((t) => t.id).sort()).toEqual(["t2", "t3"]);
		expect(bc.traces.map((t) => t.id)).toEqual(["t3"]);
		expect(cp.traces).toEqual([]);
		expect(ab.lanes).toBeNull();
		expect(ab.series).toBeNull();
	});

	test("hubOverview links carry the flow join: lanes, traces, width", () => {
		const targetEdge = baseEdge({
			id: "edge:hub:a->target:p",
			from: "hub:a",
			to: "target:p",
			evidence: "ledger",
			requests: 5,
		});
		const graph = graphFixture(
			["a", "b"],
			[
				baseEdge({
					id: "edge:hub:a->hub:b",
					from: "hub:a",
					to: "hub:b",
					requests: 8,
					lanes: 2,
					activeLanes: 1,
					series: [{ t: 0, requests: 2, failed: 0 }],
				}),
				targetEdge,
			],
			[trace("t2", ["a", "b"])],
		);
		const view = hubOverview(graph, { now: NOW, windowMs: 900_000 });
		const link = view.links.find((row) => row.id === "edge:hub:a->hub:b");
		expect(link.width).toBe(2);
		expect(link.animate).toBe(true);
		expect(link.durationS).toBe(12);
		expect(link.lanes).toBe(2);
		expect(link.activeLanes).toBe(1);
		expect(link.traces.map((t) => t.id)).toEqual(["t2"]);
		expect(link.series).toHaveLength(1);
	});
});
