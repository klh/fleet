// hooks/lib/fleet-loop/lane-allocation.ts — fork E: the hub's global lane
// cap split across every supervised project. Pure (no store, no clock): the
// loop measures live + READY per project and this decides each project's
// dispatch target for the cycle.
//
// Rules:
//   - the global ceiling bounds the SUM of live lanes across projects; a
//     project already over its share is never shrunk (lanes are never
//     killed to rebalance) — it simply receives no new slots;
//   - free slots are dealt one at a time, round-robin, to projects with
//     unmet demand (READY beyond what it already runs) and headroom under
//     its optional sub-cap;
//   - the deal starts at `rotation` (the loop advances it every cycle), so
//     a single free slot does not always land on the first registered repo.

export interface LaneDemand {
	/** canonical project identity (or any stable key) */
	key: string;
	/** live lanes the project runs now */
	live: number;
	/** READY items waiting in the project's graph */
	ready: number;
	/** optional per-project ceiling (fleet_loop.projects[].lane_target) */
	cap?: number;
}

export interface LaneAllocation {
	/** key → dispatch target (live + granted slots) */
	targets: Map<string, number>;
	/** key → slots granted this cycle */
	granted: Map<string, number>;
	/** free slots left undealt (no project had demand + headroom) */
	idle: number;
}

const whole = (n: number): number =>
	Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;

export function allocateLaneTargets(
	demands: LaneDemand[],
	globalCap: number,
	rotation = 0,
): LaneAllocation {
	const granted = new Map<string, number>(demands.map((d) => [d.key, 0]));
	const used = demands.reduce((s, d) => s + whole(d.live), 0);
	let free = Math.max(0, whole(globalCap) - used);
	const wants = (d: LaneDemand): boolean => {
		const g = granted.get(d.key) ?? 0;
		const live = whole(d.live);
		const ceiling = d.cap === undefined ? Number.POSITIVE_INFINITY : d.cap;
		return g < whole(d.ready) && live + g < ceiling;
	};
	const n = demands.length;
	const start = n > 0 ? ((whole(rotation) % n) + n) % n : 0;
	while (free > 0) {
		let dealt = false;
		for (let k = 0; k < n && free > 0; k++) {
			const d = demands[(start + k) % n];
			if (!d || !wants(d)) continue;
			granted.set(d.key, (granted.get(d.key) ?? 0) + 1);
			free--;
			dealt = true;
		}
		if (!dealt) break;
	}
	const targets = new Map<string, number>(
		demands.map((d) => [d.key, whole(d.live) + (granted.get(d.key) ?? 0)]),
	);
	return { targets, granted, idle: free };
}
