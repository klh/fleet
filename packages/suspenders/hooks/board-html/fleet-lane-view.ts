export interface GovernorLane {
	sid: string;
	state: string;
	project: string | null;
	hbAgo: number;
}

export interface HubScope {
	origin: string;
	peer: string;
	now: number;
	observations: {
		laneId: string;
		project: string;
		originHub: string;
		peerHub: string;
		expiresAt: number;
	}[];
}

/** Independent hub axes. Unknown means no unexpired observation, not local. */
export function matchesHubScope(
	sid: string | null | undefined,
	project: string | null | undefined,
	scope?: HubScope,
): boolean {
	if (!scope || (scope.origin === "all" && scope.peer === "all")) return true;
	const rows = scope.observations.filter(
		(o) => o.laneId === sid && o.project === project && o.expiresAt > scope.now,
	);
	if (!rows.length)
		return [scope.origin, scope.peer].every(
			(value) => value === "all" || value === "unknown",
		);
	return rows.some(
		(o) =>
			(scope.origin === "all" || scope.origin === o.originHub) &&
			(scope.peer === "all" || scope.peer === o.peerHub),
	);
}

/** Self-contained: the board embeds this same function in its browser script. */
export function selectGovernorLanes<T extends GovernorLane>(
	sessions: T[],
	project: string,
	scope?: HubScope,
) {
	const scoped = sessions.filter(
		(s) =>
			(project === "all" || !project || s.project === project) &&
			(!scope || matchesHubScope(s.sid, s.project, scope)),
	);
	const fresh = (s: T) => Number.isFinite(s.hbAgo) && s.hbAgo >= 0;
	const current = (s: T) =>
		fresh(s) &&
		s.hbAgo <= 300 &&
		!["CLOSED", "IDLE", "ZOMBIE"].includes(s.state);
	const recent = (s: T) => fresh(s) && s.hbAgo <= 3600;
	const sort = (a: T, b: T) =>
		Number(current(b)) - Number(current(a)) ||
		(fresh(a) ? a.hbAgo : Infinity) - (fresh(b) ? b.hbAgo : Infinity) ||
		a.sid.localeCompare(b.sid);
	return {
		current: scoped.filter(current).sort(sort),
		recent: scoped.filter(recent).sort(sort),
		history: scoped.filter((s) => !recent(s)).sort(sort),
	};
}

interface GovernorCompletion {
	id: string;
	title: string;
	updatedAgo: number;
	owner?: string | null;
}

/** One recency-ordered bound across projects, rather than 30 rows per project. */
export function selectGovernorCompletions(
	projects: { project: string; done?: GovernorCompletion[] }[],
	project: string,
	scope?: HubScope,
) {
	return projects
		.filter((p) => project === "all" || !project || p.project === project)
		.flatMap((p) =>
			(p.done || [])
				.filter(
					(done) => !scope || matchesHubScope(done.owner, p.project, scope),
				)
				.map((done) => ({ ...done, project: p.project })),
		)
		.sort(
			(a, b) =>
				(a.updatedAgo >= 0 ? a.updatedAgo : Infinity) -
					(b.updatedAgo >= 0 ? b.updatedAgo : Infinity) ||
				a.id.localeCompare(b.id),
		)
		.slice(0, 30);
}
