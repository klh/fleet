// dispatch-summary.ts — the dispatch loop's tail (W928 decomposition): the
// daemonized-pid resolve pass and the run summary/exit-code render. Bodies
// moved from dispatch-next.ts main(); state arrives as arguments, the exit
// code returns to the caller.
import { laneProcessIdentity } from "../../hooks/lib/lane-liveness.ts";

/** Structural view of a lane-registry entry — the dispatch entrypoint's
 * Lane type narrows to this. */
export type DispatchLaneLike = {
	sid: string;
	item: string;
	pid: number;
	worktree: string;
	launchedAt?: number;
};

/** The lsof -Fn probe: pid/cwd pairs of every claude/codex process. */
const daemonCwdListing = (
	sh: (cmd: string[], cwd?: string) => string,
): string =>
	sh([
		"lsof",
		"-a",
		"-p",
		sh(["ps", "-axo", "pid=,comm="])
			.split("\n")
			.filter((l) => /claude|codex/.test(l))
			.map((l) => Number.parseInt(l.trim(), 10))
			.join(","),
		"-d",
		"cwd",
		"-Fn",
	]);

/** daemonized-pid resolve, moved from dispatch-next.ts main(): the
 * `claude -p` parent re-parents away from proc.pid within minutes; one
 * settle + lsof cwd scan re-points fresh entries so the pid guard and
 * `lanes` stay honest. Mutates the passed arrays (pids re-pointed,
 * dispatched gains a note per fix). */
export const resolveDaemonizedPids = async (
	sh: (cmd: string[], cwd?: string) => string,
	dispatched: string[],
	live: DispatchLaneLike[],
): Promise<void> => {
	if (!dispatched.some((d) => d.includes("(pid "))) return;
	await Bun.sleep(3000);
	const listing = daemonCwdListing(sh);
	const byCwd = new Map<string, number>();
	let cur = "";
	for (const line of listing.split("\n")) {
		if (line.startsWith("p")) cur = line.slice(1);
		if (line.startsWith("n")) {
			const wt = byCwd.get(line.slice(1));
			byCwd.set(
				line.slice(1),
				cur && (!wt || Number(cur) > wt) ? Number(cur) : (wt ?? 0),
			);
		}
	}
	for (const l of live) {
		const resolved = byCwd.get(l.worktree);
		if (resolved && laneProcessIdentity(l) === false) {
			l.pid = resolved;
			dispatched.push(`${l.item}→${l.sid}(daemonized pid ${resolved})`);
		}
	}
};

/** starved-capability surfacing (W619): capabilities demanded by READY work
 * that no dispatchable lane sid advertises. */
const logStarved = (starved: Map<string, string[]>): void => {
	if (!starved.size) return;
	console.log(
		`capability starved: ${[...starved.entries()]
			.map(([c, items]) => `${c} (wanted by ${items.join(", ")})`)
			.join(", ")} — no dispatchable lane advertises it`,
	);
};

/** The run tail (W928, moved from dispatch-next.ts main()): summary line,
 * fleet report, refusal disclosure, READY-pool-empty note — then the exit
 * code: seed fallbacks (W695.1) and refusals (W463) are errors the caller
 * must see, never a clean "pool drained" exit. */
export type DispatchSummaryOpts = {
	liveCount: number;
	targetEff: number;
	heldSlots: number;
	dispatched: string[];
	seedFallbacks: string[];
	readyCount: number;
	resumeCount: number;
	item?: string;
	refusals: string[];
	launchWaits?: string[];
	starved: Map<string, string[]>;
	report: string | null;
};

export const dispatchSummary = (o: DispatchSummaryOpts): number => {
	console.log(
		`lanes live: ${o.liveCount}/${o.targetEff} (${o.heldSlots} unregistered/uncertain slots held)${o.dispatched.length ? ` — dispatched: ${o.dispatched.join(", ")}` : " — pool drained or lanes busy"}${o.seedFallbacks.length ? ` — seed fallback: ${o.seedFallbacks.join("; ")}` : ""}`,
	);
	// W899: the dispatch summary carries the fleet report table — same shape
	// the install tail, session-start tick and lane briefs emit.
	if (o.report) console.log(o.report);
	let code = 0;
	// W695.1: a seed fallback dispatched a lane that will re-orient from cold
	// context — never read as a fully healthy dispatch even when nothing was
	// refused.
	if (o.seedFallbacks.length > 0 && o.refusals.length === 0) code = 1;
	// W463: a governance refusal is an ERROR the caller must see — the run
	// never reads as a clean "pool drained" exit.
	if (o.refusals.length > 0)
		console.log(
			`governance: ${o.refusals.length} dispatch(es) REFUSED (fail-closed) — ${o.refusals.join(", ")}`,
		);
	if (o.launchWaits?.length)
		console.log(
			`launch backoff: ${o.launchWaits.length} item(s) waiting — ${o.launchWaits.join(", ")}`,
		);
	if (!o.item && o.readyCount === 0 && o.resumeCount === 0)
		console.log(
			"READY pool empty — register work or pull the next epic forward",
		);
	logStarved(o.starved);
	if (o.refusals.length > 0 || o.launchWaits?.length) code = 1;
	return code;
};
