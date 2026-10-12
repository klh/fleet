// hooks/board-html/fleet-lane-routes.ts — W461 stage 3 grouped lane/routes
// view (pure selectors, embedded in the board's browser script like
// fleet-lane-view.ts). Immediate-downstream grouping default: one group per
// observing hub. Distinct-lane counts are NOT additive across groups —
// origin sets overlap (upstream-observability-architecture.md §3).
export interface LaneRouteEdge {
	source: string;
	rid: string;
	lane: string;
	model: string;
	admittedAt: number;
	endedAt: number | null;
	outcome: string | null;
}

export interface LaneRouteGroup {
	source: string;
	lanes: number;
	requests: number;
	errors: number;
	active: number;
	lastAt: number;
}

const isRouteError = (outcome: string | null): boolean =>
	outcome === "errored" || outcome === "denied";

/** Client-side regroup of a /api/lane-routes snapshot for filtered views. */
export function selectLaneRouteGroups<T extends LaneRouteEdge>(
	edges: T[],
	opts: { origin?: string; errorOnly?: boolean } = {},
): {
	groups: LaneRouteGroup[];
	lanes: number;
	requests: number;
	errors: number;
} {
	const scoped = edges.filter(
		(e) =>
			(!opts.origin || e.source === opts.origin) &&
			(!opts.errorOnly || isRouteError(e.outcome)),
	);
	const bySource = new Map<
		string,
		{
			source: string;
			lanes: Set<string>;
			requests: number;
			errors: number;
			active: number;
			lastAt: number;
		}
	>();
	for (const e of scoped) {
		let g = bySource.get(e.source);
		if (!g) {
			g = {
				source: e.source,
				lanes: new Set(),
				requests: 0,
				errors: 0,
				active: 0,
				lastAt: 0,
			};
			bySource.set(e.source, g);
		}
		g.lanes.add(e.lane);
		g.requests++;
		if (isRouteError(e.outcome)) g.errors++;
		if (e.endedAt === null) g.active++;
		g.lastAt = Math.max(g.lastAt, e.admittedAt);
	}
	return {
		groups: [...bySource.values()]
			.map((g) => ({
				source: g.source,
				lanes: g.lanes.size,
				requests: g.requests,
				errors: g.errors,
				active: g.active,
				lastAt: g.lastAt,
			}))
			.sort((a, b) => b.lastAt - a.lastAt),
		lanes: new Set(scoped.map((e) => e.lane)).size,
		requests: scoped.length,
		errors: scoped.filter((e) => isRouteError(e.outcome)).length,
	};
}
