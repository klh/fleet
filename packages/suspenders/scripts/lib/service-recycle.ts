// scripts/lib/service-recycle.ts — W1073: a supervisor that abandons its
// process group (belt-swarm) leaves service-owned children listening after
// bootout/bootstrap; the restarted supervisor adopts their ports and keeps
// serving the pre-install code. The install recycles declared childPort
// listeners post-bootstrap: record the old listener pids, kill them
// (SIGTERM, SIGKILL after a bounded grace), then poll a bounded window for
// a FRESH listener — the restarted supervisor respawns the child from the
// freshly synced runtime home. All process I/O rides injectable hooks so
// the loop is deterministic under test.

export interface RecycleHooks {
	/** pids holding a LISTEN socket on the TCP port (lsof). */
	listenerPids: (port: number) => number[];
	/** Deliver a signal; false when undeliverable (already gone / EPERM). */
	signal: (pid: number, sig: "SIGTERM" | "SIGKILL") => boolean;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

export interface RecycleRequest {
	port: number;
	/** Total window for the fresh listener to appear (default 30s — the
	 *  install report fails the unit when it lapses). */
	deadlineMs?: number;
	/** SIGTERM → SIGKILL escalation window (default 3s). */
	graceMs?: number;
}

export type RecycleResult =
	| { ok: true; pid: number; oldPids: number[] }
	| { ok: false; reason: string; oldPids: number[] };

export const RECYCLE_DEADLINE_MS = 30_000;
export const RECYCLE_GRACE_MS = 3_000;

export const processRecycleHooks = (): RecycleHooks => ({
	listenerPids: (port) => {
		try {
			const out = Bun.spawnSync([
				"/usr/sbin/lsof",
				"-ti",
				`tcp:${port}`,
				"-sTCP:LISTEN",
			]);
			if (out.exitCode !== 0) return [];
			return out.stdout
				.toString()
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => /^\d+$/.test(line))
				.map((line) => Number(line));
		} catch {
			return [];
		}
	},
	signal: (pid, sig) => {
		try {
			process.kill(pid, sig);
			return true;
		} catch {
			return false;
		}
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
});
