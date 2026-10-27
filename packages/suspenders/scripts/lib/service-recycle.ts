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
	/** Executable identity of a pid (ps comm) — null when unknowable. A
	 * holder whose identity does not prove the expected child class is never
	 * signaled (W1073 B2: PID reuse / arbitrary port owners). Hooks without
	 * identity opt out of the proof (scripted tests). */
	identity?: (pid: number) => string | null;
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
	/** Identity proof a holder must match before a signal (default /bun/i —
	 *  the manifest children are bun processes). */
	expectedChild?: RegExp;
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
	identity: (pid) => {
		try {
			const out = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "comm="]);
			if (out.exitCode !== 0) return null;
			const comm = out.stdout.toString().trim();
			return comm === "" ? null : comm;
		} catch {
			return null;
		}
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
});

// W1073 B3: success needs EVERY pre-install holder gone from the port AND a
// live replacement — a fresh listener beside a surviving old holder is not a
// recycle (the old process is still serving). Returns the fresh pid, or null
// while the port is unsettled (stale holder present, or nobody listening).
const settledFresh = (
	hooks: RecycleHooks,
	port: number,
	oldPids: number[],
): number | null => {
	const holders = hooks
		.listenerPids(port)
		.filter((pid, i, all) => all.indexOf(pid) === i);
	if (holders.some((pid) => oldPids.includes(pid))) return null;
	return holders[0] ?? null;
};

// Recycle one declared child listener: kill the pre-install holders, then
// poll a bounded window for a NEW pid on the LISTEN socket — the old pid is
// never accepted back, the whole point is a respawn from the synced code.
export async function recycleChildListener(
	req: RecycleRequest,
	hooks: RecycleHooks = processRecycleHooks(),
): Promise<RecycleResult> {
	const deadlineMs = req.deadlineMs ?? RECYCLE_DEADLINE_MS;
	const graceMs = req.graceMs ?? RECYCLE_GRACE_MS;
	const expected = req.expectedChild ?? /bun/i;
	// W1073 B2: a pid is only claimable when its executable identity proves
	// the expected child class — an arbitrary process that holds (or reuses)
	// the pid number is never signaled, and an unclaimable holder fails the
	// window instead of being killed blind.
	const claimable = (pid: number): boolean => {
		if (hooks.identity === undefined) return true;
		const comm = hooks.identity(pid);
		return comm !== null && expected.test(comm);
	};
	const oldPids = hooks.listenerPids(req.port);
	const terminated: number[] = [];
	for (const pid of oldPids) {
		if (claimable(pid) && hooks.signal(pid, "SIGTERM")) terminated.push(pid);
	}
	const graceEnd = hooks.now() + graceMs;
	while (hooks.now() < graceEnd) {
		const fresh = settledFresh(hooks, req.port, oldPids);
		if (fresh !== null) return { ok: true, pid: fresh, oldPids };
		await hooks.sleep(100);
	}
	for (const pid of terminated) hooks.signal(pid, "SIGKILL");
	const hardEnd = hooks.now() + deadlineMs;
	while (hooks.now() < hardEnd) {
		const fresh = settledFresh(hooks, req.port, oldPids);
		if (fresh !== null) return { ok: true, pid: fresh, oldPids };
		await hooks.sleep(250);
	}
	const stale = oldPids.filter((pid) => !claimable(pid));
	return {
		ok: false,
		reason: `port ${req.port}: no verified fresh listener within ${deadlineMs}ms after recycling ${oldPids.length > 0 ? `pids ${oldPids.join(",")}` : "the port"}${stale.length > 0 ? ` (unverified holders left untouched: ${stale.join(",")})` : ""}`,
		oldPids,
	};
}
