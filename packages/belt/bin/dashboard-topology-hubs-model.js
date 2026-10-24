// Hub-first view model (W858.7.31, slice 2 of docs/design/hub-topology-overview.md):
// one aggregated summary per hub, endpoint fan-out collapsed to counts,
// filtered by layer (observed/connected/configured) and live window (1m/15m).
// Pure and deterministic so a refresh keeps every selected hub in place.
const HUB_LAYERS = ["observed", "connected", "configured"];
const HUB_WINDOWS = [60_000, 900_000];

const sum = (values) =>
	values.reduce((total, value) => (Number.isFinite(value) ? total + value : total), 0);

const windowStartOf = (graph, windowMs, now) =>
	Math.max(now - windowMs, Date.parse(graph.windowStart));

export function hubOverview(graph, options = {}) {
	if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
		return null;
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const windowMs = HUB_WINDOWS.includes(options.windowMs)
		? options.windowMs
		: 900_000;
	const layer = HUB_LAYERS.includes(options.layer) ? options.layer : "observed";
	const windowStart = windowStartOf(graph, windowMs, now);
	const inWindow = (value) => {
		const time = typeof value === "number" ? value : Date.parse(value);
		return Number.isFinite(time) && time >= windowStart && time <= now + 5000;
	};
	const edges = graph.edges.filter((edge) => {
		if (!inWindow(edge.lastSeenAt)) return false;
		if (layer === "observed")
			return edge.evidence !== "ledger" && edge.requests > 0;
		return true;
	});
	const configured = new Map(
		(Array.isArray(options.configuredHubs) ? options.configuredHubs : []).map(
			(hub) => [String(hub.name).toLowerCase(), hub],
		),
	);
	const summaries = new Map();
	const targetIndex = new Map();
	const addHub = (node, observed) => {
		summaries.set(node.id, {
			id: node.id,
			label: node.label,
			observed,
			state: observed ? "quiet" : "planned",
			lastSeenAt: node.lastSeenAt,
			endpoints: [],
			downstream: new Set(),
			requests: 0,
			failed: 0,
			active: 0,
			tokens: { input: null, output: null, usageBearing: 0 },
		});
	};
	for (const node of graph.nodes) {
		if (node.kind === "hub") addHub(node, true);
		else targetIndex.set(node.id, node);
	}
	for (const name of configured.keys()) {
		const id = `hub:${name}`;
		if (!summaries.has(id)) {
			addHub(
				{ id, label: name, lastSeenAt: configured.get(name).lastSeenAt ?? null },
				false,
			);
		}
	}
	for (const edge of edges) {
		const from = summaries.get(edge.from);
		const to = summaries.get(edge.to);
		if (from && to) {
			if (from.observed && to.observed) {
				from.downstream.add(to.id);
				to.downstream.add(from.id);
			}
			continue;
		}
		// endpoint traffic aggregates onto the hub that forwarded it
		const hub = from ?? to;
		const targetId = from ? edge.to : edge.from;
		const target = targetIndex.get(targetId);
		if (!hub || !target || !hub.observed) continue;
		hub.endpoints.push({
			id: target.id,
			label: target.label,
			kind: target.targetKind ?? "endpoint",
			requests: Number.isFinite(edge.requests) ? edge.requests : 0,
			failed: Number.isFinite(edge.failed) ? edge.failed : 0,
			lastSeenAt: edge.lastSeenAt,
		});
	}
	for (const hub of summaries.values()) {
		const hubEdges = edges.filter(
			(edge) => summaries.get(edge.from) === hub || summaries.get(edge.to) === hub,
		);
		hub.requests = sum(hubEdges.map((edge) => edge.requests));
		hub.failed = sum(hubEdges.map((edge) => edge.failed));
		hub.active = sum(hubEdges.map((edge) => edge.active));
		const bearing = hubEdges.filter(
			(edge) =>
				Number.isFinite(edge.inputTokens) || Number.isFinite(edge.outputTokens),
		);
		hub.tokens = {
			input: bearing.length ? sum(bearing.map((edge) => edge.inputTokens)) : null,
			output: bearing.length ? sum(bearing.map((edge) => edge.outputTokens)) : null,
			usageBearing: sum(
				bearing.map((edge) => edge.coverage?.usageBearingRequests),
			),
		};
		hub.endpoints.sort((a, b) => a.id.localeCompare(b.id));
		hub.state =
			hub.requests > 0 ? "active" : hub.observed ? "quiet" : "planned";
	}
	const hubs = [...summaries.values()].sort((a, b) => a.id.localeCompare(b.id));
	const links = edges
		.filter(
			(edge) =>
				summaries.get(edge.from)?.observed && summaries.get(edge.to)?.observed,
		)
		.map((edge) => ({
			id: edge.id,
			from: edge.from,
			to: edge.to,
			requests: Number.isFinite(edge.requests) ? edge.requests : 0,
			failed: Number.isFinite(edge.failed) ? edge.failed : 0,
			evidence: edge.evidence,
			lastSeenAt: edge.lastSeenAt,
		}));
	const query = String(options.query ?? "").trim().toLowerCase();
	const modelRows = Object.entries(options.hubModels ?? {}).flatMap(
		([name, models]) =>
			hubs
				.filter((hub) => hub.label.toLowerCase() === name.toLowerCase())
				.flatMap((hub) => models.map((model) => ({ hub, model }))),
	);
	const search = query
		? [
				...hubs
					.filter((hub) =>
						`${hub.label} ${hub.id}`.toLowerCase().includes(query),
					)
					.map((hub) => ({ id: hub.id, label: hub.label, kind: "hub", via: "" })),
				...modelRows
					.filter((row) => row.model.toLowerCase().includes(query))
					.map((row) => ({
						id: row.hub.id,
						label: row.model,
						kind: "model",
						via: row.hub.label,
					})),
			]
		: [];
	const estate = {
		hubs: hubs.length,
		endpoints: hubs.reduce((total, hub) => total + hub.endpoints.length, 0),
		requests:
			sum(links.map((link) => link.requests)) +
			sum(hubs.flatMap((hub) => hub.endpoints.map((item) => item.requests))),
		failed:
			sum(links.map((link) => link.failed)) +
			sum(hubs.flatMap((hub) => hub.endpoints.map((item) => item.failed))),
	};
	return {
		layer,
		windowMs,
		hubs,
		links,
		search,
		estate,
		observedAt: graph.observedAt,
		windowStart: graph.windowStart,
	};
}

/** Deterministic hub-card columns: BFS depth over hub↔hub links, rows stable
 * by id, so a refresh moves nothing. */
export function hubOverviewLayout(hubs, links) {
	const depth = new Map(hubs.map((hub) => [hub.id, 0]));
	for (let pass = 0; pass < Math.min(hubs.length, 5); pass++) {
		let changed = false;
		for (const link of links) {
			const next = Math.min(5, (depth.get(link.from) ?? 0) + 1);
			if (next > (depth.get(link.to) ?? 0)) {
				depth.set(link.to, next);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const rows = new Map();
	const nodes = [...hubs]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((hub) => {
		const column = depth.get(hub.id) ?? 0;
		const row = rows.get(column) ?? 0;
		rows.set(column, row + 1);
		return { ...hub, x: 20 + column * 224, y: 20 + row * 84 };
	});
	return {
		nodes,
		width: Math.max(640, 40 + (Math.max(0, ...depth.values()) + 1) * 224),
		height: Math.max(320, 40 + Math.max(0, ...rows.values()) * 84),
	};
}

