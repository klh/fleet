// fleet-loop/retire.ts — merged-branch retirement: registry reconcile,
// liveness verdicts, and the W463 lane-key revocation (W740 split from the
// fleet-loop entrypoint; bodies verbatim).

import { existsSync, readFileSync, statSync } from "node:fs";
import { retireLaneKey } from "../lanes/lane-auth.ts";
import { laneAlive, laneProcessIdentity } from "../lanes/lane-liveness.ts";
import {
	readLaneRegistry,
	retirementProcessLive,
	safeToRetire,
} from "../lanes/lane-registry.ts";
import { openStore, projectIdentity } from "../govdb/govdb.ts";
import type { Lane, LoopDeps } from "./runtime.ts";

export type RetireSurface = {
	laneIsAlive: (b: string) => boolean | null;
	retireMerged: (b: string) => void;
};

export function createRetire(deps: LoopDeps): RetireSurface {
	const { REPO, log, sh, runCap, lanes, ahead } = deps;
	/** Actual worktree path checked out at branch b, from git's registry —
	 *  gaps parks lanes under .claude/worktrees/ (not .worktrees/), so the
	 *  default-path guess misses them and branch delete stalls on "used by
	 *  worktree" (autow294.1, 2026-09-28). */
	function wtPathFromGit(b: string): string | null {
		const out = sh(["git", "worktree", "list", "--porcelain"]);
		let path: string | null = null;
		for (const line of out.split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
			else if (line.startsWith("branch ")) {
				if (line.slice("branch ".length).trim() === `refs/heads/${b}` && path)
					return path;
			}
		}
		return null;
	}

	/** liveness = THE surface's verdict (hooks/lib/lanes/lane-liveness.ts) for tracked
	 * lanes; untracked branches keep the worktree-cwd probe as EVIDENCE for this
	 * sweep (W494.1: cwd is evidence, never a liveness term). Survives the
	 * unregistered spawn window and DISPATCHED-less dispatchers. */
	function laneIsAlive(b: string): boolean | null {
		// W494.1: tracked lanes ask THE surface (work lanes verdict — shared with
		// dispatch-next); untracked branches keep the worktree evidence probe
		const tracked = lanes().find((l) => l.branch === b);
		if (tracked && laneAlive(tracked)) return true;
		if (tracked && laneProcessIdentity(tracked) === null) return null;
		const wt =
			wtPathFromGit(b) ?? `${REPO}/.worktrees/${b.replace(/^.*\//, "")}`;
		return retirementProcessLive(wt);
	}

	function retireMerged(b: string): void {
		// kill switch (gaps 2026-09-30: live lanes retired ~90s after dispatch —
		// marker contract drift vs their new dispatcher). Touch
		// .fleet/retires-paused to pause ALL retires; delete the file to resume.
		if (existsSync(`${REPO}/.fleet/retires-paused`)) return;
		if (ahead(b) !== 0) return;
		const registry = readLaneRegistry<Lane>(REPO);
		if (!registry.known) {
			log(`RETIRE-BLOCKED ${b} — registry unknown: ${registry.error}`);
			return;
		}
		const entry = registry.lanes.find((row) => row.branch === b);
		const item = entry?.item ?? b.split("/").at(-1);
		let claimKnown = false,
			claimed = false;
		try {
			const store = openStore();
			try {
				const claim = store
					.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
					.get(projectIdentity(REPO), item) as { state: string } | undefined;
				claimKnown =
					!claim ||
					[
						"READY",
						"CLAIMED",
						"RUNNING",
						"DONE",
						"FAILED",
						"BLOCKED",
						"SHATTERED",
						"SUPERSEDED",
						"PAUSED",
						"CANCELLED",
					].includes(claim.state);
				claimed = !!claim && ["CLAIMED", "RUNNING"].includes(claim.state);
			} finally {
				store.close();
			}
		} catch {}
		if (
			!safeToRetire({
				registryKnown: registry.known,
				claimKnown,
				claimed,
				recentlyLaunched:
					!!entry && Date.now() - (entry.launchedAt ?? 0) < 10 * 60_000,
				live: laneIsAlive(b),
			})
		)
			return;

		// ahead=0 is also true for a freshly-dispatched lane's pre-commit branch —
		// never retire a branch a LIVE lane still owns. Tracked-pid alone raced
		// gaps' dispatch-next (registers lanes.json async, writes no DISPATCHED
		// lines) — liveness is now tracked pid OR any live supported-agent process
		// whose cwd is inside the worktree (gaps 2026-09-30 incident; W309 widened
		// the process match beyond claude/codex)
		const tracked = lanes().find((l) => l.branch === b);
		// worktree path: git's registry is ground truth — gaps parks lanes under
		// .claude/worktrees/ (not .worktrees/), so the bare default guess misses
		// them and branch delete stalls on "used by worktree"
		const wt =
			wtPathFromGit(b) ??
			tracked?.worktree ??
			`${REPO}/.worktrees/${b.replace(/^.*\//, "")}`;
		// mid-spawn grace (2026-09-28 gaps autow298/299): dispatch registers the
		// branch immediately but gaps' async wrapper lands the lanes.json entry
		// 22–55s later — the ladder saw ahead=0 with NO entry, the pid guard had
		// nothing to check, and retire fired on a lane mid-spawn.
		if (!tracked) {
			// evidence of a recent dispatch → skip (unregistered spawn window)
			try {
				const line = readFileSync(`${REPO}/.fleet/loop.log`, "utf8")
					.split("\n")
					.reverse()
					.find((l) => l.includes("DISPATCHED") && l.includes(b));
				const ts = line ? Date.parse(line.slice(0, 24)) : Number.NaN;
				if (Number.isFinite(ts) && Date.now() - ts < 10 * 60_000) return;
			} catch {}
			// gaps 2026-09-30: dispatch-next writes NO DISPATCHED lines, so
			// "no evidence" is the norm, not a signal — a seconds-old worktree is
			// the pre-spawn window, not debris. Skip while young; genuine debris
			// (laneIsAlive already confirmed nothing runs in it) retires once aged.
			// FLEET_UNTRACKED_GRACE_MS=0 fast-forwards the grace (tests, manual
			// debris cleanup).
			try {
				if (
					Date.now() - statSync(wt).birthtimeMs <
					Number(process.env.FLEET_UNTRACKED_GRACE_MS ?? 120_000)
				)
					return;
			} catch {}
		}
		// REFERENCE BEFORE DELETE (gaps incident 2026-09-28): pin the tip to a
		// recovery ref before any destructive step, so a later -D or an
		// aggressive prune can never orphan the commits.
		const tip = sh(["git", "rev-parse", "--verify", b]);
		if (tip)
			runCap([
				"git",
				"update-ref",
				`refs/recover/${b.replace(/\//g, "-")}-${Date.now()}`,
				tip,
			]);
		if (existsSync(wt)) {
			let rm = runCap(["git", "worktree", "remove", "--force", wt]);
			if (rm.code !== 0) {
				// stale worktree registration (git's metadata outlived a dead lane) —
				// prune and retry once; a second failure is logged with git's reason
				runCap(["git", "worktree", "prune"]);
				rm = runCap(["git", "worktree", "remove", "--force", wt]);
			}
			if (rm.code !== 0)
				log(
					`RETIRE-STALL ${b} — worktree remove failed: ${rm.out.split("\n").slice(-2).join(" | ")}`,
				);
		}
		const delD = runCap(["git", "branch", "-d", b]);
		const del = delD.code === 0 ? null : runCap(["git", "branch", "-D", b]);
		if (delD.code === 0 || (del && del.code === 0)) log(`RETIRED ${b}`);
		else
			log(
				`RETIRE-BLOCKED ${b} — branch delete failed: ${del ? del.out.split("\n").slice(-2).join(" | ") : "?"}`,
			);
		// W463 lane-key lifecycle: the same point that knows the lane ended
		// revokes its buckle key and deletes the per-lane files — no new daemon.
		// Fire-and-forget: this path is sync; the fetch keeps the process warm
		// until the revoke settles, and the loop.log line lands in .then.
		if (tracked)
			void retireLaneKey({ fleet: `${REPO}/.fleet`, sid: tracked.sid })
				.then((rk) => {
					if (rk.keyId)
						log(
							`LANE-KEY ${tracked.sid} — key ${rk.keyId} ${rk.revoked ? "revoked" : "revoke failed (24h TTL bounds it)"}`,
						);
				})
				.catch(() => {});
	}
	return { laneIsAlive, retireMerged };
}
