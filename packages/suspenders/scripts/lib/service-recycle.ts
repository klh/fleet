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

// distinct pids on the port that were NOT the pre-install holders
const freshHolders = (
	hooks: RecycleHooks,
	port: number,
	oldPids: number[],
): number[] =>
	hooks
		.listenerPids(port)
		.filter((pid) => !oldPids.includes(pid))
		.filter((pid, i, all) => all.indexOf(pid) === i);

// Recycle one declared child listener: kill the pre-install holders, then
// poll a bounded window for a NEW pid on the LISTEN socket — the old pid is
// never accepted back, the whole point is a respawn from the synced code.
export async function recycleChildListener(
	req: RecycleRequest,
	hooks: RecycleHooks = processRecycleHooks(),
): Promise<RecycleResult> {
	const deadlineMs = req.deadlineMs ?? RECYCLE_DEADLINE_MS;
	const graceMs = req.graceMs ?? RECYCLE_GRACE_MS;
	const oldPids = hooks.listenerPids(req.port);
	const terminated: number[] = [];
	for (const pid of oldPids) {
		if (hooks.signal(pid, "SIGTERM")) terminated.push(pid);
	}
	const graceEnd = hooks.now() + graceMs;
	while (hooks.now() < graceEnd) {
		const fresh = freshHolders(hooks, req.port, oldPids);
		if (fresh.length > 0) return { ok: true, pid: fresh[0] as number, oldPids };
		await hooks.sleep(100);
	}
	for (const pid of terminated) hooks.signal(pid, "SIGKILL");
	const hardEnd = hooks.now() + deadlineMs;
	while (hooks.now() < hardEnd) {
		const fresh = freshHolders(hooks, req.port, oldPids);
		if (fresh.length > 0) return { ok: true, pid: fresh[0] as number, oldPids };
		await hooks.sleep(250);
	}
	return {
		ok: false,
		reason: `port ${req.port}: no fresh listener within ${deadlineMs}ms after recycling ${oldPids.length > 0 ? `pids ${oldPids.join(",")}` : "the port"}`,
		oldPids,
	};
}
