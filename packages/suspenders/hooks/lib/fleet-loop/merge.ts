// fleet-loop/merge.ts — the merge ladder: per-branch merges through the
// repo's ladder, 3-strike park, merge-runner liveness, crashed-merge heal
// (W740 split from the fleet-loop entrypoint; bodies verbatim).

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { have } from "../run.ts";
import { openStore, projectIdentity } from "../govdb/govdb.ts";
import {
	doneShaResolves,
	gitInProgress,
	itemClaimOf,
} from "../lanes/ladder-lease.ts";
import { mergeHoldActive } from "./merge-hold.ts";
import { flagIntegratedCode } from "../decomposition.ts";
import {
	bankDanglingRef,
	danglingReferences,
	unresolvedSpecifiers,
} from "./dangling-paths.ts";
import { guardedMerge } from "./merge-guard.ts";
import {
	checkReviewReceipt,
	reviewContext,
	recordLanding,
} from "../gates/review-receipt.ts";
import type { LoopDeps } from "./runtime.ts";
import { scheduleReview } from "../gates/review-scheduler.ts";

export type MergeLadder = {
	mergeOne: (b: string) => undefined | "missing";
	mergeFail: (b: string, tail: string) => void;
	mergeRunnerAlive: () => number | null;
	healCrashedMerge: () => void;
};
export function createMergeLadder(
	deps: LoopDeps & {
		CALLER_REPO: string;
		LADDER: string | undefined;
		LADDER_TIMEOUT_MS: number;
		laneIsAlive: (b: string) => boolean | null;
		retireMerged: (b: string) => void;
	},
): MergeLadder {
	const {
		REPO,
		CALLER_REPO,
		LADDER,
		LADDER_TIMEOUT_MS,
		log,
		sh,
		run,
		runCap,
		ahead,
		laneIsAlive,
		retireMerged,
		bumpFail,
		clearFail,
	} = deps;
	// A rejected isolated ladder: preserve shared main, count the strike, park at 3.
	function mergeFail(b: string, tail: string): void {
		// guardedMerge cleans only its owned scratch worktree. Never abort an
		// unrelated merge another runner may have begun in the shared checkout.
		log(
			`FAIL ${b} — isolated ladder rejected, shared checkout preserved, branch left for inspection${tail ? `: ${tail}` : ""}`,
		);
		try {
			openStore()
				.query(
					"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'fleet-loop', 'NEED_DECISION', ?, ?, NULL)",
				)
				.run(
					Date.now(),
					b,
					JSON.stringify({
						project: projectIdentity(REPO),
						note: `Merge rejected for ${b}: ${tail || "ladder failure"}; branch preserved for inspection.`,
					}),
				);
		} catch {
			/* rejection remains recorded in loop.log if the bus is unavailable */
		}
		const n = bumpFail(b);
		if (n >= 3) {
			const parked = b.replace(/^([^/]+)\//, "parked/");
			run(["git", "branch", "-m", b, parked]);
			log(
				`PARKED ${b} → ${parked} after ${n} failed ladder attempts — needs a repair lane`,
			);
			clearFail(b);
		}
	}

	// W641: the ladder's lease gate lives in hooks/lib/lanes/ladder-lease.ts

	// one branch through the ladder — the cycle's per-branch body, shared with
	// the board's one-click ship (`ship --branch <b>` runs it foreground).
	// Fail-isolated: a failed ladder aborts the merge, leaves the branch for
	// inspection, and counts toward the 3-strike park like every other merge.
	function mergeOne(b: string): undefined | "missing" {
		const n = ahead(b);
		if (n < 0) {
			log(`MERGE-DEFER ${b} — branch ref missing (parked or deleted)`);
			return "missing";
		}
		// W1072.2 fail-closed gates BEFORE retirement AND the ladder: an
		// operator merge hold defers BOTH (a merged branch's worktree/branch
		// stays put while the operator integrates provenance); Git in-progress
		// state (cherry-pick/merge/rebase) defers the ladder. Deferral, never a
		// strike/decision.
		if (mergeHoldActive(REPO)) {
			log(`MERGE-DEFER ${b} — operator merge hold (.fleet/merge-hold)`);
			return;
		}
		const inprog = gitInProgress(REPO);
		if (inprog) {
			log(`MERGE-DEFER ${b} — ${inprog}`);
			return;
		}
		if (n === 0) {
			const integrated = itemClaimOf(REPO, b);
			if (integrated.state === "DONE" && integrated.resultSha) {
				const store = openStore();
				try {
					recordLanding(
						store,
						REPO,
						projectIdentity(REPO),
						integrated.item,
						b,
						integrated.resultSha,
					);
				} catch (error) {
					log(`LANDING-DEFER ${b} — ${String(error).slice(0, 300)}`);
					return;
				} finally {
					store.close();
				}
			}
			retireMerged(b);
			return;
		}
		// never merge a branch a live lane still owns (gaps 2026-09-30: autow351
		// was merged mid-flight with 3 live pids in its worktree — the ladder
		// treated ahead>0 as ready and its retire swept the worktree out from
		// under the agents). W1124.16: the veto is tri-state honest — ONLY a
		// proven-dead lane (explicit false) lets the merge through; live defers
		// silently (the mid-flight norm), unknown defers loudly (a failed probe
		// is never death — monitor doctrine W51).
		const live = laneIsAlive(b);
		if (live === true) return;
		if (live === null) {
			log(
				`MERGE-DEFER ${b} — lane liveness unknown (probe failure is never death); deferring`,
			);
			return;
		}
		// W641 ladder lease: the govdb lease outranks every liveness signal — a
		// branch whose item is CLAIMED/RUNNING never merges, even with its lane
		// process dead (pre-reclaim window) or unregistered. A store failure makes
		// the lease unverifiable, which blocks too: the must is never merge
		// leased work, and the next cycle retries.
		const claim = itemClaimOf(REPO, b);
		if (claim.blocked) {
			log(`LEASE-BLOCK ${b} — ${claim.reason}`);
			return;
		}
		// W101: a live .fleet/merge-active marker means another runner is
		// mid-ladder (the marker is written BEFORE the merge starts, so it can
		// be live with no MERGE_HEAD yet) — never start a second ladder over
		// it; the next cycle or ship run retries once the runner finishes
		const liveRunner = mergeRunnerAlive();
		if (liveRunner) {
			log(`MERGE-BUSY ${b} — runner pid ${liveRunner} mid-flight, skipped`);
			return;
		}
		// W1072.2: the exact closure predicate — only a DONE item whose
		// result_sha resolves to the exact branch HEAD may merge. Unknown,
		// stale-sha, reclaimed and empty-sha closures all fail closed here; the
		// next cycle retries (a defer, not a strike).
		const exact = doneShaResolves(REPO, b, claim);
		if (!exact.ok) {
			log(`MERGE-DEFER ${b} — ${exact.why}`);
			return;
		}
		const verifyReview = (candidate?: string) => {
			const store = openStore();
			try {
				const context = reviewContext(REPO, b);
				if (
					candidate &&
					JSON.stringify(reviewContext(REPO, candidate).instructions) !==
						JSON.stringify(context.instructions)
				)
					return {
						ok: false,
						why: "integration changed reviewed instructions",
					};
				return checkReviewReceipt(
					store,
					projectIdentity(REPO),
					claim.item,
					context,
				);
			} catch (error) {
				return { ok: false, why: String(error).slice(0, 300) };
			} finally {
				store.close();
			}
		};
		const review = verifyReview();
		if (!review.ok) {
			log(`MERGE-DEFER ${b} — review required: ${review.why}`);
			const store = openStore();
			try {
				log(
					`REVIEW ${b} — ${scheduleReview({ db: store, project: projectIdentity(REPO), item: claim.item, repo: REPO, context: reviewContext(REPO, b) })}`,
				);
			} catch (error) {
				log(`REVIEW-DEFER ${b} — ${String(error).slice(0, 300)}`);
			} finally {
				store.close();
			}
			return;
		}
		// liveness marker: a crash between --no-commit and commit leaves
		// MERGE_HEAD + staged debris that plain merge --abort cannot clear (the
		// 2026-09-28 gaps stall). The marker tells the next cycle whether a
		// merge runner is genuinely alive or the state is debris.
		const marker = `${REPO}/.fleet/merge-active`;
		// ship mode on a fresh repo has no .fleet/ yet (watch always did) — W64
		// tests caught the ENOENT (2026-09-29)
		mkdirSync(`${REPO}/.fleet`, { recursive: true });
		writeFileSync(
			marker,
			JSON.stringify({
				pid: process.pid,
				// exact-identity check: a recycled pid must also carry the runner's
				// own command line to count as live (gaps 18517f51 follow-up)
				cmd: process.argv.join(" "),
				branch: b,
				ts: Date.now(),
			}),
		);
		const before = sh(["git", "rev-parse", "--short", "HEAD"]);
		const mv = guardedMerge({
			repo: REPO,
			callerRepo: CALLER_REPO,
			branch: b,
			ladder: LADDER,
			timeoutMs: LADDER_TIMEOUT_MS,
			verifyReview,
		});
		if (mv.code === 0) {
			let after = sh(["git", "rev-parse", "--short", "HEAD"]);
			log(`MERGED ${b} ${before}→${after}`);
			// W869 merge-time quality floor: auto-fix the branch's deferred cosmetic
			// lint here on the shared checkout — a completion never runs outside
			// worktrees, so merge time is the one honest moment (fail-open).
			const fix = qltyFixMergedFiles({
				repo: REPO,
				branch: b,
				files: sh(["git", "diff", "--name-only", `${before}..${after}`])
					.split("\n")
					.filter(Boolean),
			});
			if (fix.fixed) log(`QLTY-FIXED ${b} → ${fix.head}`);
			if (fix.left)
				log(
					`QLTY-FIX-LEFT ${b}: ${fix.left} unfixable issue(s) — logged, never blocks`,
				);
			if (fix.head) after = fix.head;
			// W1302.2 (A6): post-merge dangling-path scan — deleted paths still
			// referenced by live files, and unresolvable specifiers among the
			// merge's own delta. Fail-open: findings mint repair items + events;
			// a scan failure never un-merges.
			try {
				const changed = sh([
					"git",
					"diff",
					"--name-only",
					"--diff-filter=ACMR",
					`${before}..${after}`,
				])
					.split("\n")
					.filter(Boolean);
				const dangling = [
					...danglingReferences(REPO, before, after),
					...unresolvedSpecifiers(REPO, after, changed),
				];
				for (const ref of dangling) {
					log(
						`DANGLING-PATH ${b}: ${ref.target} referenced by ${ref.refBy}${ref.line ? `:${ref.line}` : ` (${ref.specifier})`}`,
					);
					bankDanglingRef(REPO, "fleet-loop", ref, after);
				}
				if (dangling.length)
					log(`DANGLING-PATHS ${b}: ${dangling.length} finding(s) queued`);
			} catch (error) {
				log(
					`DANGLING-SCAN-FAILED ${b}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			try {
				for (const file of flagIntegratedCode({
					repo: REPO,
					before,
					after,
					source: "fleet-loop",
				}))
					log(
						`DECOMPOSITION ${file.path}: ${file.lines} lines — queued DRY and imported-module decomposition`,
					);
			} catch (error) {
				log(
					`DECOMPOSITION-CHECK-FAILED ${b}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			// work.landed on the bus: waiting lanes use `coord wait --kinds
			// work.landed --scope <item>` instead of /tmp poll scripts
			try {
				const store = openStore();
				try {
					recordLanding(
						store,
						REPO,
						projectIdentity(REPO),
						claim.item,
						b,
						claim.resultSha ?? b,
					);
				} finally {
					store.close();
				}
			} catch (error) {
				log(`LANDING-DEFER ${b} — ${String(error).slice(0, 300)}`);
				try {
					rmSync(marker);
				} catch {}
				return;
			}
			clearFail(b);
		} else {
			if (mv.tail.startsWith("review required:"))
				log(`MERGE-DEFER ${b} — ${mv.tail}`);
			else mergeFail(b, mv.tail);
		}
		try {
			rmSync(`${REPO}/.fleet/merge-active`);
		} catch {}
		// W1072.2: the hold defers retirement too — the branch just merged, but
		// its worktree/branch stay put while the operator owns the checkout.
		if (mergeHoldActive(REPO)) {
			log(`RETIRE-DEFER ${b} — operator merge hold, worktree/branch preserved`);
			return;
		}
		retireMerged(b);
	}

	/** pid of a live merge runner, or null. A stale marker (dead pid, or older
	 * than 30 min — a watchdog-killed runner whose unlink never ran) reads as
	 * debris. */
	function mergeRunnerAlive(): number | null {
		try {
			const j = JSON.parse(
				readFileSync(`${REPO}/.fleet/merge-active`, "utf8"),
			) as { pid: number; cmd?: string; ts: number };
			if (Date.now() - j.ts > 30 * 60_000) return null;
			process.kill(j.pid, 0);
			// kill(pid,0) is forgeable — a recycled pid is "alive" but is not the
			// merge runner; the marker must carry the runner's exact command line
			// and the process must still match it (gaps 18517f51 follow-up).
			// Markers without cmd predate the identity check → never trusted.
			if (!j.cmd) return null;
			const cmd = Bun.spawnSync(["ps", "-o", "command=", "-p", String(j.pid)])
				.stdout.toString()
				.trim();
			if (cmd !== j.cmd) return null;
			return j.pid;
		} catch {
			return null;
		}
	}

	/** Recover a crashed merge: a dead runner left MERGE_HEAD + staged debris.
	 * SURGICAL FIRST — restore only STAGED paths (index column of porcelain) to
	 * the index, which is what blocks merge --abort; unstaged paths may be a
	 * bystander session's WIP and are never touched. Guarded reset --hard is
	 * the last resort, loud, and only when no live runner exists. */
	function healCrashedMerge(): void {
		const head = sh(["git", "rev-parse", "--short", "MERGE_HEAD"]) || "?";
		const branch = sh(["git", "name-rev", "--name-only", "MERGE_HEAD"]) || head;
		const staged = sh(["git", "status", "--porcelain"])
			.split("\n")
			.filter((l) => l.length > 3 && l[0] !== " " && l[0] !== "?")
			.map((l) => l.slice(3).trim());
		if (staged.length)
			run([
				"git",
				"checkout",
				"--",
				...staged.map((p) => p.split(" -> ").pop() ?? p),
			]);
		const ab = runCap(["git", "merge", "--abort"]);
		if (ab.code === 0) {
			// POST-CONDITION (gaps 18517f51): a bare commit in the healed state
			// must not be able to conclude anything — MERGE_HEAD gone AND the
			// index clean. checkout -- restores the worktree FROM the index and
			// leaves entries staged, so verify and sweep any remnant with a
			// mixed reset (index only; worktree untouched).
			const left = sh(["git", "status", "--porcelain"])
				.split("\n")
				.filter((l) => l.length > 3 && l[0] !== " " && l[0] !== "?");
			if (left.length > 0 || existsSync(`${REPO}/.git/MERGE_HEAD`)) {
				run(["git", "reset"]);
				log(
					`SELF-HEAL crashed merge of ${branch} (${head}): aborted, ${left.length} staged remnant(s) cleared via mixed reset`,
				);
				return;
			}
			log(
				`SELF-HEAL crashed merge of ${branch} (${head}): restored ${staged.length} path(s) from index to worktree, aborted clean, index verified empty`,
			);
			return;
		}
		run(["git", "reset", "--hard"]);
		log(
			`SELF-HEAL crashed merge of ${branch} (${head}): surgical abort failed (${ab.out.slice(0, 120)}), discarded staged debris via guarded reset --hard`,
		);
	}
	return { mergeOne, mergeFail, mergeRunnerAlive, healCrashedMerge };
}

// ---- W869: merge-time quality floor ----------------------------------------
/** Run qlty check --fix over the merged branch's code files, then commit any
 * applied fixes on main so the shared checkout never carries the lane's
 * deferred cosmetic lint (a completion never runs outside worktrees).
 * Fail-open: no qlty on PATH, no surviving code files, or a broken run never
 * blocks the merge; unfixable issues are counted and logged, never fatal.
 * Returns the new head sha when a fix commit landed, else null. */
export function qltyFixMergedFiles(opts: {
	repo: string;
	branch: string;
	files: string[];
}): { fixed: boolean; head: string | null; left: number } {
	const code = opts.files
		.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
		.filter((f) => existsSync(join(opts.repo, f)));
	if (!code.length || !have("qlty"))
		return { fixed: false, head: null, left: 0 };
	const dec = new TextDecoder();
	const spawn = (cmd: string[]) =>
		Bun.spawnSync(cmd, {
			cwd: opts.repo,
			stdout: "pipe",
			stderr: "pipe",
		});
	const check = spawn([
		"qlty",
		"check",
		"--fix",
		"--no-upgrade-check",
		"--no-progress",
		...code,
	]);
	const out = `${check.stdout ? dec.decode(check.stdout) : ""}${check.stderr ? dec.decode(check.stderr) : ""}`;
	const left = Number(/ISSUES:\s*(\d+)/.exec(out)?.[1] ?? 0);
	// qlty 0.649 reports biome lint fixes without applying them — the write
	// pass goes through the cached biome binary, with the promoted rule set
	// (recommended + noNonNullAssertion) injected via a scratch config.
	if (left > 0) {
		const biome = biomeBin();
		if (biome) {
			const cfgDir = biomeScratchConfig();
			spawn([
				biome,
				"check",
				"--write",
				"--unsafe",
				...(cfgDir ? ["--config-path", cfgDir] : []),
				"--no-errors-on-unmatched",
				...code,
			]);
		}
	}
	const st = spawn(["git", "status", "--porcelain", "--", ...code]);
	const dirty = st.stdout
		.toString()
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => l.slice(3).trim());
	if (!dirty.length) return { fixed: false, head: null, left };
	spawn(["git", "add", "--", ...dirty]);
	const c = spawn([
		"git",
		"commit",
		"-m",
		`${opts.branch}: merge-time qlty autofix (W869)`,
	]);
	if ((c.exitCode ?? 1) !== 0) return { fixed: false, head: null, left };
	return {
		fixed: true,
		head: spawn(["git", "rev-parse", "--short", "HEAD"])
			.stdout.toString()
			.trim(),
		left,
	};
}

/** The qlty-cached biome binary — the only writer that applies biome lint
 * fixes (qlty check --fix reports them without applying, 0.649).
 * SUSPENDERS_BIOME_BIN overrides; null = skip the fix pass (fail-open). */
export function biomeBin(): string | null {
	const envBin = process.env.SUSPENDERS_BIOME_BIN;
	if (envBin) return existsSync(envBin) ? envBin : null;
	try {
		const root = join(process.env.HOME ?? "", ".qlty/cache/tools/biome");
		const versions = readdirSync(root)
			.filter((d) => /^[0-9]/.test(d))
			.sort()
			.reverse();
		for (const v of versions) {
			const bin = join(root, v, "node_modules/@biomejs/biome/bin/biome");
			if (existsSync(bin)) return bin;
		}
	} catch {}
	return null;
}

/** Scratch biome config dir (os tmpdir) carrying the promoted rule set —
 * recommended lints plus noNonNullAssertion, which biome's defaults leave
 * off but the qlty plugin enables. Written once, outside any repo. */
export function biomeScratchConfig(): string | null {
	try {
		const dir = join(tmpdir(), "klh-w869-biome");
		mkdirSync(dir, { recursive: true });
		const cfg = join(dir, "biome.json");
		if (!existsSync(cfg))
			writeFileSync(
				cfg,
				JSON.stringify({
					linter: {
						enabled: true,
						rules: {
							recommended: true,
							style: { noNonNullAssertion: "error" },
						},
					},
				}),
			);
		return dir;
	} catch {
		return null;
	}
}
