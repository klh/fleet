const FRESH_MS = 120_000;
const ROUTE_MS = 15 * 60_000;

/** The topology snapshot is a separate, trace-backed source. Keep endpoint
 * targets distinct from catalog providers until a configured identity joins
 * them; a local ledger target alone does not prove a provider hop. */
export function observedGraph(payload, now = Date.now()) {
	const snapshot = payload?.topology;
	if (
		!snapshot?.ok ||
		snapshot.schemaVersion !== 1 ||
		!isFresh(snapshot.observedAt, now) ||
		!Number.isFinite(Date.parse(snapshot.windowStart))
	)
		return null;
	const nodes = [
		...(Array.isArray(snapshot.hubs) ? snapshot.hubs : []).map((hub) => ({
			id: hub.id,
			label: hub.name,
			kind: "hub",
			lastSeenAt: hub.lastSeenAt,
		})),
		...(Array.isArray(snapshot.targets) ? snapshot.targets : []).map(
			(target) => ({
				id: target.id,
				label: `${target.host}${target.port === null ? "" : `:${target.port}`}`,
				kind: "endpoint",
				targetKind: target.kind,
				lastSeenAt: target.lastSeenAt,
			}),
		),
	].filter((node) => typeof node.id === "string" && node.id);
	nodes.sort((a, b) => a.id.localeCompare(b.id));
	const ids = new Set(nodes.map((node) => node.id));
	const edges = (Array.isArray(snapshot.edges) ? snapshot.edges : [])
		.filter(
			(edge) =>
				ids.has(edge.from) &&
				ids.has(edge.to) &&
				Number.isFinite(edge.requests) &&
				edge.requests >= 0,
		)
		.map((edge) => ({
			...edge,
			failed: Number.isFinite(edge.failed) ? edge.failed : null,
			active: Number.isFinite(edge.active) ? edge.active : null,
			inputTokens: Number.isFinite(edge.inputTokens) ? edge.inputTokens : null,
			outputTokens: Number.isFinite(edge.outputTokens)
				? edge.outputTokens
				: null,
			coverage: edge.coverage ?? null,
			fresh: isFresh(edge.lastSeenAt, now, 60_000),
		}));
	edges.sort((a, b) => a.id.localeCompare(b.id));
	const coverage = snapshot.coverage ?? {};
	return {
		observedAt: snapshot.observedAt,
		windowStart: snapshot.windowStart,
		nodes,
		edges,
		traces: Array.isArray(snapshot.traces) ? snapshot.traces : [],
		totals: {
			requests: Number.isFinite(snapshot.totals?.requests)
				? snapshot.totals.requests
				: null,
			failed: Number.isFinite(snapshot.totals?.failed)
				? snapshot.totals.failed
				: null,
			active: Number.isFinite(snapshot.totals?.active)
				? snapshot.totals.active
				: null,
			inputTokens:
				coverage.tokensScope === "local-origin-ledger" &&
				Number.isFinite(snapshot.totals?.inputTokens)
					? snapshot.totals.inputTokens
					: null,
			outputTokens:
				coverage.tokensScope === "local-origin-ledger" &&
				Number.isFinite(snapshot.totals?.outputTokens)
					? snapshot.totals.outputTokens
					: null,
		},
		coverage,
	};
}

/** Deterministic columns keep a viewer's selected route in place on refresh. */
export function observedGraphLayout(graph) {
	const depth = new Map(graph.nodes.map((node) => [node.id, 0]));
	for (let pass = 0; pass < Math.min(graph.nodes.length, 5); pass++) {
		let changed = false;
		for (const edge of graph.edges) {
			const next = Math.min(5, (depth.get(edge.from) ?? 0) + 1);
			if (next > (depth.get(edge.to) ?? 0)) {
				depth.set(edge.to, next);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const rows = new Map();
	const nodes = graph.nodes.map((node) => {
		const column = depth.get(node.id) ?? 0;
		const row = rows.get(column) ?? 0;
		rows.set(column, row + 1);
		return { ...node, x: 20 + column * 224, y: 52 + row * 76 };
	});
	return {
		nodes,
		width: Math.max(720, 40 + (Math.max(0, ...depth.values()) + 1) * 224),
		height: Math.max(310, 76 + Math.max(0, ...rows.values()) * 76),
	};
}

const isFresh = (value, now, limit = FRESH_MS) => {
	const time = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(time) && time <= now && now - time <= limit;
};

const observed = (observation, now) =>
	Number.isFinite(observation?.expiresAt) && observation.expiresAt > now;

const stateOf = (up, fresh) => (!fresh ? "unknown" : up ? "up" : "down");

const providerKey = (host) => {
	const value = String(host || "").toLowerCase();
	if (value.endsWith("githubcopilot.com")) return "copilot";
	if (value.endsWith("z.ai")) return "zai";
	if (value.endsWith("openai.com")) return "openai";
	if (value.endsWith("anthropic.com")) return "anthropic";
	return value || "unknown provider";
};

/** Add Buckle observations to Belt's probe inventory without treating a
 * routed request as a current health probe or inventing an upstream hop. */
export function addNetworkEvidence(machines, payload, now = Date.now()) {
	if (!payload?.ok || !payload.network?.ok || !isFresh(payload.ts, now))
		return machines;
	const result = new Map(
		machines.map((item) => [item.name.toLowerCase(), { ...item }]),
	);
	const interfaces = Array.isArray(payload.network.throughput?.interfaces)
		? payload.network.throughput.interfaces
		: [];
	for (const row of interfaces) {
		if (row.kind !== "cloud" || !row.host || !Number.isFinite(row.req15))
			continue;
		const key = providerKey(row.host);
		const item = result.get(key) || {
			name: key,
			endpoints: 0,
			reachable: 0,
			routed: 0,
			models: [],
			state: "unknown",
		};
		if (row.model && !item.models.includes(row.model))
			item.models = [...item.models, row.model];
		item.buckleReq15 = (item.buckleReq15 || 0) + row.req15;
		item.buckleReq60 = (item.buckleReq60 || 0) + (row.req60 || 0);
		if (Number.isFinite(row.out60))
			item.outTokens60 = (item.outTokens60 || 0) + row.out60;
		if (isFresh(row.lastOkAt, now, ROUTE_MS)) {
			item.routeObserved = true;
			if (!item.lastOkAt || row.lastOkAt > item.lastOkAt)
				item.lastOkAt = row.lastOkAt;
		}
		result.set(key, item);
	}
	return [...result.values()];
}

export function gatewayTraffic(payload, now = Date.now()) {
	if (!payload?.ok || !payload.network?.ok || !isFresh(payload.ts, now))
		return null;
	const interfaces = Array.isArray(payload.network.throughput?.interfaces)
		? payload.network.throughput.interfaces
		: [];
	return interfaces.reduce(
		(total, row) => ({
			requests60:
				total.requests60 + (Number.isFinite(row.req60) ? row.req60 : 0),
			inputTokens60: Number.isFinite(row.in60)
				? (total.inputTokens60 ?? 0) + row.in60
				: total.inputTokens60,
			outputTokens60: Number.isFinite(row.out60)
				? (total.outputTokens60 ?? 0) + row.out60
				: total.outputTokens60,
			observedTargets:
				total.observedTargets +
				(Number.isFinite(row.req60) && row.req60 > 0 ? 1 : 0),
		}),
		{
			requests60: 0,
			inputTokens60: null,
			outputTokens60: null,
			observedTargets: 0,
		},
	);
}

export function buildTopology(
	status,
	remotes,
	supervisor,
	now = Date.now(),
	networkPayload = null,
	access = null,
	context = null,
) {
	const localFresh = observed(status?.observation, now);
	const remoteFresh = isFresh(remotes?.ts, now);
	const hubFresh = observed(supervisor?.observation, now);
	const specialists = Array.isArray(status?.specialists)
		? status.specialists
		: [];
	const ready = specialists.filter(
		(item) => item.state_label === "ready",
	).length;
	const idle = specialists.filter((item) =>
		item.state_label?.startsWith("idle"),
	).length;
	const localAttention = specialists.length - ready - idle;
	const models = specialists.map((item) => ({
		role: String(item.role || "model"),
		port: item.port,
		model: item.model_served || "model not loaded",
		load5m: Number.isFinite(item.load_5m) ? item.load_5m : null,
		label: String(item.state_label || "unknown"),
		state: !localFresh
			? "unknown"
			: item.state_label === "ready"
				? "up"
				: item.state_label?.startsWith("idle")
					? "idle"
					: "attention",
	}));
	const hubs = Array.isArray(supervisor?.targets)
		? supervisor.targets.filter((item) => item.kind === "hub")
		: [];
	const rows = Array.isArray(remotes?.rows) ? remotes.rows : [];
	const routes = Array.isArray(remotes?.routes) ? remotes.routes : [];
	const machines = new Map();
	for (const row of rows) {
		const name = String(row.machine || "unknown");
		const item = machines.get(name) || {
			name,
			endpoints: 0,
			reachable: 0,
			probed: 0,
			routed: 0,
			models: [],
		};
		item.endpoints += 1;
		if (row.ok) item.reachable += 1;
		if (row.last_seen) item.probed += 1;
		if (row.reason?.startsWith("missing api key"))
			item.unconfigured = (item.unconfigured || 0) + 1;
		if (
			typeof row.model === "string" &&
			row.model &&
			!item.models.includes(row.model)
		)
			item.models.push(row.model);
		machines.set(name, item);
	}
	for (const route of routes) {
		const item = machines.get(String(route.machine || "unknown"));
		if (item && route.ok && isFresh(route.ts, now, ROUTE_MS)) item.routed += 1;
	}
	const networkFresh = networkPayload?.ok && isFresh(networkPayload.ts, now);
	const hubConsoles = new Map(
		(Array.isArray(context?.hubConsoles) ? context.hubConsoles : []).map(
			(item) => [String(item.name).toLowerCase(), item.url],
		),
	);
	const hubCards = hubs.map((item) => ({
		name: String(item.name),
		...(hubConsoles.has(String(item.name).toLowerCase())
			? { consoleUrl: hubConsoles.get(String(item.name).toLowerCase()) }
			: {}),
		...(item.displayName ? { displayName: String(item.displayName) } : {}),
		state: stateOf(item.state === "up" && !item.alert, hubFresh),
		port: item.port,
	}));
	const machineCards = addNetworkEvidence(
		[...machines.values()].map((item) => ({
			...item,
			state:
				item.unconfigured === item.endpoints
					? "unconfigured"
					: !remoteFresh || !item.probed
						? "unknown"
						: item.reachable > 0
							? "up"
							: "down",
		})),
		networkPayload,
		now,
	);
	const hubNames = new Set(hubCards.map((item) => item.name.toLowerCase()));
	const providers = machineCards
		.filter((item) => !hubNames.has(item.name.toLowerCase()))
		.map((item) => ({ ...item, key: item.name.toLowerCase() }));
	const copilot = access?.copilot || null;
	if (copilot) {
		const found = providers.find((item) => item.key === "copilot");
		const catalogModels = Array.isArray(copilot.models)
			? copilot.models.map((model) => model.routes?.[0] ?? model.id)
			: [];
		if (found) {
			found.models = [...new Set([...found.models, ...catalogModels])];
			found.name = "IKEA Copilot";
			found.kind = "copilot";
			found.catalog = copilot;
		} else {
			providers.unshift({
				key: "copilot",
				name: "IKEA Copilot",
				kind: "copilot",
				state: copilot.state === "catalog reachable" ? "up" : "unknown",
				models: catalogModels,
				endpoints: 0,
				reachable: 0,
				probed: 0,
				routed: 0,
				catalog: copilot,
			});
		}
	}
	const hops =
		networkFresh &&
		networkPayload.network?.ok &&
		Array.isArray(networkPayload.network.hops)
			? networkPayload.network.hops
			: [];
	const audit15 =
		networkFresh && networkPayload.network?.ok
			? (networkPayload.network.audit15 ?? null)
			: null;
	const hubObservationsAvailable =
		networkFresh && networkPayload.network?.observations?.available === true;
	const links = hubCards.map((hub) => {
		const observedHop = hops.find(
			(hop) =>
				String(hop.origin).toLowerCase() === "local" &&
				String(hop.peer).toLowerCase() === hub.name.toLowerCase() &&
				Number.isFinite(hop.n) &&
				hop.n > 0 &&
				Number.isFinite(hop.lastAt) &&
				now - hop.lastAt <= ROUTE_MS,
		);
		return {
			target: `hub:${hub.name.toLowerCase()}`,
			evidence: observedHop ? "observed" : "probe",
			...(observedHop
				? {
						requests15: observedHop.n,
						source: "hub observations",
						lastSeen: observedHop.lastAt,
					}
				: {
						requests15: hubObservationsAvailable ? 0 : null,
						source: hubObservationsAvailable
							? "hub observations"
							: "hub observations unavailable",
					}),
			failures15: null,
		};
	});
	for (const provider of providers) {
		const failed = Array.isArray(audit15?.failures)
			? audit15.failures.filter(
					(row) =>
						row.kind === "cloud" && providerKey(row.host) === provider.key,
				)
			: [];
		const failures15 = audit15
			? failed.reduce((sum, row) => sum + row.count, 0)
			: null;
		const lastFailure =
			failed
				.map((row) => row.lastAt)
				.sort()
				.at(-1) ?? null;
		if (provider.routeObserved && Number.isFinite(provider.buckleReq15))
			links.push({
				target: `provider:${provider.key}`,
				evidence: "observed",
				requests15: provider.buckleReq15,
				failures15,
				source: "local Buckle ledger",
				lastSeen: provider.lastOkAt ?? lastFailure,
			});
		else if (
			provider.state !== "unconfigured" &&
			(provider.endpoints > 0 ||
				provider.catalog?.models?.some((model) => model.buckle))
		)
			links.push({
				target: `provider:${provider.key}`,
				evidence: "configured",
				requests15: audit15 ? 0 : null,
				failures15,
				source: audit15 ? "local Buckle ledger" : "Buckle ledger unavailable",
				lastSeen: lastFailure,
			});
	}
	return {
		router: stateOf(status?.router?.up, localFresh),
		gateway:
			networkFresh && networkPayload.gateway
				? String(
						networkPayload.gateway.state ||
							(networkPayload.gateway.up ? "up" : "down"),
					)
				: "unknown",
		gatewayTraffic: gatewayTraffic(networkPayload, now),
		observedGraph: observedGraph(networkPayload, now),
		audit15,
		lastAuditAt: networkFresh
			? (networkPayload.network?.lastAuditAt ?? null)
			: null,
		recentSuccessAt: networkFresh
			? (networkPayload.network?.recentSuccessAt ?? null)
			: null,
		localConsoleUrl: context?.localConsoleUrl ?? null,
		work: context?.work ?? null,
		specialists: {
			state: !localFresh
				? "unknown"
				: localAttention
					? "attention"
					: ready
						? "up"
						: "idle",
			ready,
			idle,
			attention: localAttention,
			models,
		},
		hubs: hubCards,
		machines: machineCards,
		providers,
		links,
		copilot,
		fresh: { local: localFresh, hubs: hubFresh, remotes: remoteFresh },
	};
}
