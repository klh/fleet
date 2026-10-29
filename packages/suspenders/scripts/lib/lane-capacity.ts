// scripts/lib/lane-capacity.ts — hub design D4: which registry lanes hold a
// refill slot. dispatch-next counted capacity with its own stricter test
// (audit/pid AND a claude/codex cwd inside the worktree, or a <10-min launch
// grace) while `work lanes` reports the shared verdict (pid identity OR a
// fresh claimant transcript). A lane the plane calls live but whose process
// cwd is not the worktree fell out of the count, so refill launched past
// lane_target (16 live vs 8 observed 2026-10-29) and could even pick the
// still-running lane as a resume candidate. A lane now occupies a slot when
// EITHER test says live — capacity errs toward fewer launches, never more.

export interface CapacityProbes<L> {
	/** the shared plane verdict (lane-liveness laneAlive — `work lanes`) */
	shared: (lane: L) => boolean;
	/** dispatch-next's own launch-evidence test (cwd probe + grace) */
	dispatch: (lane: L) => boolean;
}

export function occupiesSlot<L>(lane: L, probes: CapacityProbes<L>): boolean {
	return probes.shared(lane) || probes.dispatch(lane);
}

export function liveForCapacity<L>(lanes: L[], probes: CapacityProbes<L>): L[] {
	return lanes.filter((l) => occupiesSlot(l, probes));
}
