// merge-on-done.ts — W249 frequent-merge bias: the ladder reacts to `work
// done` instead of waiting for the next watch cycle. Two halves:
//   • work.ts done → triggerMergeOnDone: a dispatched lane's close spawns a
//     DETACHED `fleet-loop flush --item <id> --await <secs>` child — never
//     throws, never blocks the close; no registry entry (manual close) skips.
//   • fleet-loop flush → flushOnDoneWait: bounded wait for the closing lane
//     to exit (the alive-lane veto protects live work — gaps autow351 merged
//     mid-flight and its retire swept the worktree from under the agents),
//     then the sweep merges seconds after exit instead of at the next 120s
//     cycle. Timeout defers loudly; the daemon sweep still owns the branch.
//     W1124.16: the veto is tri-state honest — only a PROVEN-dead lane
//     (explicit false) reads ready; an unknown probe (null) defers.
import { join } from "node:path";
import { readLaneRegistry } from "../lanes/lane-registry.ts";

const POLL_MS = 2_000;
const branchList = (repo: string, pattern?: string): string[] =>
	Bun.spawnSync(
		pattern
			? ["git", "branch", "--list", pattern, "--format", "%(refname:short)"]
			: ["git", "branch", "--format", "%(refname:short)"],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	)
		.stdout.toString()
		.trim()
		.split("\n")
		.filter(Boolean);

/** The branch a closed item's lane owns: the registry entry first (it names
 *  the branch exactly), else the one local branch whose suffix is the item —
 *  the branch-suffix law fleet-loop's own retire path reads items by. */
export function resolveItemBranch(repo: string, item: string): string | null {
	const registry = readLaneRegistry<{ branch: string; item: string }>(repo);
	const entry = registry.known
		? registry.lanes.find((row) => row.item === item)
		: undefined;
	if (entry?.branch) return entry.branch;
	return branchList(repo).find((b) => b.endsWith(`/${item}`)) ?? null;
}

const branchExists = (repo: string, branch: string): boolean =>
	branchList(repo, branch).includes(branch);

/** Bounded wait for the closing lane to exit. `alive` is the CALLER's
 *  liveness surface (fleet-loop's laneIsAlive — THE surface, no drift). A
 *  branch that vanishes mid-wait is already merged or retired: stop early.
 *  W1124.16: ONLY a proven-dead lane reads ready — this verdict authorizes
 *  a merge, and an unknown probe (null) is never death. Unknown and live
 *  both wait out the deadline and land as timeout (a loud defer). */
export async function awaitLaneExit(
	repo: string,
	branch: string,
	deadlineMs: number,
	alive: (b: string) => boolean | null,
	pollMs = POLL_MS,
): Promise<"ready" | "timeout" | "gone"> {
	// the common case is a proven-dead lane (manual close) — no async loop
	if (alive(branch) === false) return "ready";
	const deadline = Date.now() + Math.max(0, deadlineMs);
	while (Date.now() < deadline) {
		if (!branchExists(repo, branch)) return "gone";
		if (alive(branch) === false) return "ready";
		await Bun.sleep(pollMs);
	}
	return !branchExists(repo, branch) ? "gone" : "timeout";
}

export type FlushOnDoneResult =
	| { exit: boolean; branch: string; verdict: "ready" | "timeout" | "gone" }
	| { exit: boolean; branch: null; verdict: "no-branch" };

/** flush's --item gate: resolve the closed item's branch, wait out the lane
 *  (bounded by awaitSecs), log the loud defers. `exit` means the caller must
 *  stop (nothing mergeable found); `branch` joins the sweep set either way. */
export async function flushOnDoneWait(
	repo: string,
	item: string | undefined,
	awaitSecs: number,
	alive: (b: string) => boolean | null,
	log: (msg: string) => void,
): Promise<FlushOnDoneResult> {
	if (!item) return { exit: false, branch: null, verdict: "no-branch" };
	const branch = resolveItemBranch(repo, item);
	if (!branch) {
		log(`FLUSH-DEFER --item ${item} — no matching branch`);
		return { exit: true, branch: null, verdict: "no-branch" };
	}
	const verdict = await awaitLaneExit(repo, branch, awaitSecs * 1000, alive);
	if (verdict === "timeout")
		log(
			`FLUSH-AWAIT-TIMEOUT ${branch} — lane alive at await deadline; daemon sweep owns it`,
		);
	return { exit: false, branch, verdict };
}

/** work done's fire-and-forget: when the closed item has a lane in the
 *  registry (a dispatched lane closed its own work item), spawn the detached
 *  flush that waits out the lane's exit and merges; never throws. */
export function triggerMergeOnDone(repo: string, item: string): boolean {
	if (process.env.FLEET_MERGE_ON_DONE === "0") return false;
	try {
		const registry = readLaneRegistry<{ sid: string; item: string }>(repo);
		const lane = registry.known
			? registry.lanes.find((row) => row.item === item)
			: undefined;
		if (!lane) return false;
		const awaitSecs = Math.max(
			0,
			Number(process.env.FLEET_MERGE_ON_DONE_AWAIT_SECS ?? 120),
		);
		const proc = Bun.spawn({
			cmd: [
				process.execPath,
				join(import.meta.dir, "..", "..", "bin", "fleet-loop.ts"),
				"flush",
				"--repo",
				repo,
				"--item",
				item,
				"--await",
				String(awaitSecs),
			],
			cwd: repo,
			detached: true,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		proc.unref();
		return true;
	} catch {
		return false;
	}
}
