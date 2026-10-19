const FRESH_MS = 120_000;
const ROUTE_MS = 15 * 60_000;

const isFresh = (value, now, limit = FRESH_MS) => {
	const time = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(time) && time <= now && now - time <= limit;
};

const observed = (observation, now) =>
	Number.isFinite(observation?.expiresAt) && observation.expiresAt > now;

const stateOf = (up, fresh) => (!fresh ? "unknown" : up ? "up" : "down");

export function buildTopology(status, remotes, supervisor, now = Date.now()) {
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
			routed: 0,
		};
		item.endpoints += 1;
		if (row.ok) item.reachable += 1;
		machines.set(name, item);
	}
	for (const route of routes) {
		const item = machines.get(String(route.machine || "unknown"));
		if (item && route.ok && isFresh(route.ts, now, ROUTE_MS)) item.routed += 1;
	}
	return {
		router: stateOf(status?.router?.up, localFresh),
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
		hubs: hubs.map((item) => ({
			name: String(item.name),
			state: stateOf(item.state === "up" && !item.alert, hubFresh),
			port: item.port,
		})),
		machines: [...machines.values()].map((item) => ({
			...item,
			state: stateOf(item.reachable > 0, remoteFresh),
		})),
		fresh: { local: localFresh, hubs: hubFresh, remotes: remoteFresh },
	};
}
