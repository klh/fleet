// same-process.ts — W2180: process identity is pid AND start time, never pid
// alone (macOS recycles pids within seconds; kill(pid,0) blesses whoever now
// owns the number). Ported from saranyan/agent-relay handoff.py same_process():
// ESRCH stays dead, an unobservable start stays unknown (conservative alive —
// the lease remains the backstop), and a live pid whose start sits outside the
// 2s tolerance of the recorded stamp is a recycled pid = death evidence.
// Consumers: review-scheduler reconcileReviewLegs (stamped reviewer legs) and
// lane-liveness laneProcessIdentity (etime roster; after-direction only — a
// process started BEFORE the stamp is not death evidence, W51).

/** handoff.py tolerance: starts within 2s read as the same process — ps etime
 * floors to whole seconds, so a genuine process observes ≤1s late. */
export const RECYCLE_TOLERANCE_MS = 2_000;

export interface ProcessProbe {
	/** true = a process exists at the pid; false = ESRCH; null = unprobeable. */
	alive: boolean | null;
	/** Observed process birth (epoch ms); null when unobservable. */
	startMs: number | null;
}
export type ProcessProbeFn = (pid: number) => ProcessProbe;

/** ps etime token ([[dd-]hh:]mm:ss|ss) → ms; null when the token is not an
 * etime. One etime grammar shared with the lane-liveness roster parser.
 * Parts right-align (mm:ss is the macOS-norm form): "00:01" is one SECOND,
 * not one hour — the h:m:s destructure this replaces read mm:ss as h=0,m=1
 * and NaN'd the seconds, silently no-opping the W1072.3 recycle check for
 * every process under an hour. */
export const etimeToMs = (token: string): number | null => {
	if (!/^(?:\d+-)?(?:\d{1,2}:){0,2}\d{1,2}$/.test(token)) return null;
	const [day, time] = token.split("-");
	const dayMs = time ? Number(day) * 86_400_000 : 0;
	const [s = 0, m = 0, h = 0] = [...(time ?? day).split(":")]
		.reverse()
		.map(Number);
	return dayMs + ((h * 60 + m) * 60 + s) * 1_000;
};

/** The real probe: `ps -p <pid> -o etime=`. Non-zero exit = no such process
 * (ESRCH); an exit-0 row we cannot parse stays alive-but-unobservable. */
export const psProcessProbe: ProcessProbeFn = (pid) => {
	const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "etime="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) return { alive: false, startMs: null };
	const elapsed = etimeToMs(result.stdout.toString().trim());
	return {
		alive: true,
		startMs: elapsed === null ? null : Date.now() - elapsed,
	};
};

export type SameProcessVerdict = "same" | "dead" | "recycled" | "unknown";

/** handoff.py same_process() — identity of the process at `pid` against the
 * recorded stamp: ESRCH → dead; alive but the start is unobservable (or no
 * start was recorded) → unknown, never death evidence; observed start beyond
 * the 2s tolerance of the stamp → recycled (a different process owns the
 * pid); within tolerance → same. */
export function sameProcess(
	expected: { pid: number; processStartMs?: number },
	probe: ProcessProbeFn = psProcessProbe,
): SameProcessVerdict {
	const observed = probe(expected.pid);
	if (observed.alive === false) return "dead";
	if (typeof expected.processStartMs !== "number") return "unknown";
	if (observed.startMs === null) return "unknown";
	return Math.abs(observed.startMs - expected.processStartMs) <
		RECYCLE_TOLERANCE_MS
		? "same"
		: "recycled";
}
