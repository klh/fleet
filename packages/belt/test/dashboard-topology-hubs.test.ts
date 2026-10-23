// W858.7.31 slice-2 unit tests: hubOverview aggregation + hubOverviewLayout
// determinism (1/10/100 hubs, shuffled input order → same positions).
import { describe, expect, test } from "bun:test";
import {
	hubOverview,
	hubOverviewLayout,
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
			[
				hubEdge("hub:a", "hub:b", { requests: 3, lastSeenAt: at(120) }),
			],
		);
		const fresh = hubOverview(graph, { now: NOW, windowMs: 900_000 });
		const minute = hubOverview(graph, { now: NOW, windowMs: 60_000 });
		expect(fresh.hubs).toHaveLength(2);
		expect(fresh.links).toHaveLength(1);
		expect(minute.links).toHaveLength(0);
		expect(minute.hubs.every((hub) => hub.state === "quiet")).toBe(true);
	});

	test("layers: observed hides ledger edges, configured adds planned hubs, connected keeps quiet hubs", () =>
		{
		const graph = graphFixture(
			["a", "b"],
			[
				hubEdge("hub:a", "hub:b", { requests: 0, evidence: "ledger" }),
			],
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
		expect(labels).toEqual([
			"glm-5.3 via a",
			"glm-5.3-flash via b",
		]);
	});

	test("tokens: touching edges sum, no report stays null", () => {
		const graph = graphFixture(
			["a", "b"],
			[
				hubEdge("hub:a", "hub:b", { requests: 2, inputTokens: 10, outputTokens: null }),
				hubEdge("hub:b", "hub:a", { requests: 1, inputTokens: null, outputTokens: 40 }),
			],
		);
		const view = hubOverview(graph, { now: NOW });
		const a = view.hubs.find((hub) => hub.id === "hub:a");
		expect(a.tokens.input).toBe(10);
		expect(a.tokens.output).toBe(40);
		const quiet = graphFixture(["a", "b"], [
			hubEdge("hub:a", "hub:b", { requests: 1, inputTokens: null, outputTokens: null }),
		]);
		const quietView = hubOverview(quiet, { now: NOW });
		const qa = quietView.hubs.find((hub) => hub.id === "hub:a");
		expect(qa.tokens.input).toBeNull();
		expect(qa.tokens.output).toBeNull();
		expect(qa.tokens.usageBearing).toBe(0);
	});

	test("layout is deterministic at 1, 10 and 100 hubs under shuffled input order", () => {
		const pad = (i) => `hub-${String(i).padStart(2, "0")}`;
		const build = (count) => {
			const hubs = Array.from({ length: count }, (_, i) => ({ id: `hub:${pad(i)}`, label: pad(i) }));
			const links = Array.from({ length: count - 1 }, (_, i) => ({
				from: `hub:${pad(i)}`,
				to: `hub:${pad(i + 1)}`,
			}));
			return { hubs, links };
		};
		const spots = (nodes) => nodes.map((node) => `${node.id}@${node.x},${node.y}`).join("|");
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
