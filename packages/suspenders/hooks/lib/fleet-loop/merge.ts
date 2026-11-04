// fleet-loop/merge.ts — the merge ladder: per-branch merges through the
// repo's ladder, 3-strike park, merge-runner liveness, crashed-merge heal
// (W740 split from the fleet-loop entrypoint; bodies verbatim).

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	checkReviewReceipt,
	recordLanding,
	reviewContext,
} from "../gates/review-receipt.ts";
import { scheduleReview } from "../gates/review-scheduler.ts";
import { openStore, projectIdentity } from "../govdb/govdb.ts";
import { invalidateForLanding } from "../knowledge/knowledge-invalidate.ts";
import { withKnowledgeDb } from "../knowledge/sqlite-store.ts";
import {
	doneShaResolves,
	gitInProgress,
	itemClaimOf,
} from "../lanes/ladder-lease.ts";
import type { FleetLoopSettings } from "../stack-config.ts";
import { flagIntegratedCode } from "../work/decomposition.ts";
import {
	bankDanglingRefs,
	danglingReferences,
	unresolvedSpecifiers,
} from "./dangling-paths.ts";
import { CLASSIFIER_PATHS, recordDanglingFix } from "./dangling-rejudge.ts";
import {
	clearStuck,
	ensureRepairItem,
	isConflictWhy,
	noteStuckDefer,
} from "./ladder-repair.ts";
// W2561: the per-item merge defer (a branch-scoped merge-hold)
import {
	deferFileName,
	MERGE_DEFER_DIR,
	mergeDeferredActive,
} from "./merge-defer.ts";
import { guardedMerge } from "./merge-guard.ts";
import { mergeHoldActive } from "./merge-hold.ts";
// W2681: the W869 merge-time autofix moved to merge-qlty.ts and now runs
// inside the guarded merge (pre-publish) — re-exported here for the
// established import face (test/w869-quality-timing.test.ts).
export {
	biomeBin,
	biomeScratchConfig,
	qltyFixMergedFiles,
} from "./merge-qlty.ts";
import { reviewEvalsAfterMerge } from "./review-evals.ts";
import {
	candidatePaths,
	classifyRiskTier,
	emitRiskDecision,
	type RiskClassification,
} from "../gates/risk-tier.ts";
import type { LoopDeps } from "./runtime.ts";

// W1183: the ladder reports what ACTUALLY happened — never a count of
// attempts. Every mergeOne exit carries one receipt; flush/ship reporting
// propagates it verbatim (deferred/live/review-defer can no longer pass as
// merged). Guards themselves are untouched.
export type MergeReceipt = {
	branch: string;
	/** merged = the ladder landed it · integrated = already in main (ahead 0,
	 * retired) · deferred = a gate kept it for a later cycle · failed = the
	 * ladder rejected it (strike) · missing = the branch ref is gone (parked
	 * or deleted — ship refuses, flush counts it deferred) */
	outcome: "merged" | "integrated" | "deferred" | "failed" | "missing";
	/** post-merge (qlty-fix included) short head, when the ladder landed */
	head?: string;
	/** gate/ladder reason for a defer, or the landing note on a merge */
	why?: string;
};
export type MergeLadder = {
	mergeOne: (b: string) => MergeReceipt;
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
		/** W2351: the live fleet_loop settings getter (the loop watcher's
		 *  hot-applied view) — rides into scheduleReview so the reviewer
		 *  spawn env sources the conf's reviewer rows. Absent = env-only. */
		settings?: () => FleetLoopSettings;
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
		settings,
	} = deps;
	const STUCK = `${REPO}/.fleet/merge-stuck.json`;
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
		// W2179: a conflict with main is rebase work, never a silent defer
		if (isConflictWhy(tail)) repairItem(b, "rebase", tail);
		if (n >= 3) {
			const parked = b.replace(/^([^/]+)\//, "parked/");
			run(["git", "branch", "-m", b, parked]);
			log(
				`PARKED ${b} → ${parked} after ${n} failed ladder attempts — ${repairItem(b, "repair", `parked as ${parked} after ${n} failed attempts: ${tail}`)}`,
			);
			clearFail(b);
			clearStuck(STUCK, b);
		}
	}

	// W2179: one open rebase/repair item per branch; mint failures log, never throw
	function repairItem(
		b: string,
		kind: "rebase" | "repair",
		detail: string,
	): string {
		try {
			const r = ensureRepairItem(REPO, b, kind, detail);
			if (r.minted) log(`REPAIR-QUEUED ${b} — ${kind} item ${r.id}`);
			return r.id ? `repair item ${r.id}` : "repair item mint refused";
		} catch (error) {
			return `repair item mint failed: ${String(error).slice(0, 200)}`;
		}
	}

	// W2179: a DONE branch deferred past the max age raises NEED_DECISION once
	function deferStuck(b: string, item: string, why: string): void {
		log(`MERGE-DEFER ${b} — ${why}`);
		try {
			if (noteStuckDefer(REPO, b, item, why, { file: STUCK }))
				log(`STUCK ${b} — NEED_DECISION raised: ${why}`);
		} catch {
			/* the defer itself is already logged */
		}
	}

	// W641: the ladder's lease gate lives in hooks/lib/lanes/ladder-lease.ts

	// one branch through the ladder — the cycle's per-branch body, shared with
	// the board's one-click ship (`ship --branch <b>` runs it foreground).
	// Fail-isolated: a failed ladder aborts the merge, leaves the branch for
	// inspection, and counts toward the 3-strike park like every other merge.
	function mergeOne(b: string): MergeReceipt {
		const n = ahead(b);
		if (n < 0) {
			log(`MERGE-DEFER ${b} — branch ref missing (parked or deleted)`);
			return {
				branch: b,
				outcome: "missing",
				why: "branch ref missing (parked or deleted)",
			};
		}
		// W1072.2 fail-closed gates BEFORE retirement AND the ladder: an
		// operator merge hold defers BOTH (a merged branch's worktree/branch
		// stays put while the operator integrates provenance); Git in-progress
		// state (cherry-pick/merge/rebase) defers the ladder. Deferral, never a
		// strike/decision.
		if (mergeHoldActive(REPO)) {
			log(`MERGE-DEFER ${b} — operator merge hold (.fleet/merge-hold)`);
			return { branch: b, outcome: "deferred", why: "operator merge hold" };
		}
		// W2561: the per-item defer (branch-scoped) — a DONE-item branch an
		// operator parks mid-install; provenance + expiry identical to a hold
		if (mergeDeferredActive(REPO, b)) {
			log(
				`MERGE-DEFER ${b} — per-item defer (${MERGE_DEFER_DIR}/${deferFileName(b)})`,
			);
			return {
				branch: b,
				outcome: "deferred",
				why: `per-item merge defer (${MERGE_DEFER_DIR}/${deferFileName(b)})`,
			};
		}
		const inprog = gitInProgress(REPO);
		if (inprog) {
			log(`MERGE-DEFER ${b} — ${inprog}`);
			return { branch: b, outcome: "deferred", why: inprog };
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
					return {
						branch: b,
						outcome: "deferred",
						why: `landing deferred: ${String(error).slice(0, 160)}`,
					};
				} finally {
					store.close();
				}
			}
			retireMerged(b);
			return { branch: b, outcome: "integrated" };
		}
		// never merge a branch a live lane still owns (gaps 2026-09-30: autow351
		// was merged mid-flight with 3 live pids in its worktree — the ladder
		// treated ahead>0 as ready and its retire swept the worktree out from
		// under the agents). W1124.16: the veto is tri-state honest — ONLY a
		// proven-dead lane (explicit false) lets the merge through; live defers
		// silently (the mid-flight norm), unknown defers loudly (a failed probe
		// is never death — monitor doctrine W51).
		const live = laneIsAlive(b);
		if (live === true)
			return {
				branch: b,
				outcome: "deferred",
				why: "lane still live (the mid-flight norm)",
			};
		if (live === null) {
			log(
				`MERGE-DEFER ${b} — lane liveness unknown (probe failure is never death); deferring`,
			);
			return {
				branch: b,
				outcome: "deferred",
				why: "lane liveness unknown (probe failure is never death)",
			};
		}
		// W641 ladder lease: the govdb lease outranks every liveness signal — a
		// branch whose item is CLAIMED/RUNNING never merges, even with its lane
		// process dead (pre-reclaim window) or unregistered. A store failure makes
		// the lease unverifiable, which blocks too: the must is never merge
		// leased work, and the next cycle retries.
		const claim = itemClaimOf(REPO, b);
		if (claim.blocked) {
			log(`LEASE-BLOCK ${b} — ${claim.reason}`);
			return { branch: b, outcome: "deferred", why: claim.reason };
		}
		// W101: a live .fleet/merge-active marker means another runner is
		// mid-ladder (the marker is written BEFORE the merge starts, so it can
		// be live with no MERGE_HEAD yet) — never start a second ladder over
		// it; the next cycle or ship run retries once the runner finishes
		const liveRunner = mergeRunnerAlive();
		if (liveRunner) {
			log(`MERGE-BUSY ${b} — runner pid ${liveRunner} mid-flight, skipped`);
			return {
				branch: b,
				outcome: "deferred",
				why: `merge runner pid ${liveRunner} mid-flight`,
			};
		}
		// W1072.2: the exact closure predicate — only a DONE item whose
		// result_sha resolves to the exact branch HEAD may merge. Unknown,
		// stale-sha, reclaimed and empty-sha closures all fail closed here; the
		// next cycle retries (a defer, not a strike).
		const exact = doneShaResolves(REPO, b, claim);
		if (!exact.ok) {
			deferStuck(b, claim.item, exact.why);
			return { branch: b, outcome: "deferred", why: exact.why };
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
			// W2179: merge-tree failing to preview IS a conflict with main —
			// strike it (rebase item, park at 3) instead of deferring forever
			if (isConflictWhy(review.why)) {
				const why = `conflicts with main (${review.why})`;
				mergeFail(b, why);
				return { branch: b, outcome: "failed", why };
			}
			deferStuck(b, claim.item, `review required: ${review.why}`);
			const store = openStore();
			try {
				log(
					`REVIEW ${b} — ${scheduleReview({ db: store, project: projectIdentity(REPO), item: claim.item, repo: REPO, context: reviewContext(REPO, b), settings })}`,
				);
			} catch (error) {
				log(`REVIEW-DEFER ${b} — ${String(error).slice(0, 300)}`);
			} finally {
				store.close();
			}
			return {
				branch: b,
				outcome: "deferred",
				why: `review required: ${review.why}`,
			};
		}
		// W1303.5 risk tiers: the change sets the tier, not the author; blast
		// radius sets the bar. Low merges after the machine receipt; medium/high
		// defer with a deduped NEED_DECISION event instead of a silent guarded
		// merge — agent approval never fills a human slot (how-to-review.md).
		// SUSPENDERS_RISK_TIERS=0 is the operator escape hatch (manual merges).
		let risk: RiskClassification;
		try {
			risk =
				process.env.SUSPENDERS_RISK_TIERS === "0"
					? { tier: "low", approvals: 0, reasons: [] }
					: classifyRiskTier(candidatePaths(REPO, "HEAD", b));
		} catch (error) {
			log(
				`MERGE-DEFER ${b} — risk tier unavailable: ${String(error).slice(0, 300)}`,
			);
			return {
				branch: b,
				outcome: "deferred",
				why: "risk tier unavailable",
			};
		}
		if (risk.approvals > 0) {
			try {
				const store = openStore();
				try {
					emitRiskDecision(
						store,
						projectIdentity(REPO),
						claim.item,
						REPO,
						b,
						risk,
					);
				} finally {
					store.close();
				}
			} catch {
				/* the RISK-DEFER log line is the durable record if the bus is down */
			}
			log(
				`RISK-DEFER ${b} — ${risk.tier} tier needs ${risk.approvals} human approval(s): ${risk.reasons.join("; ")}`,
			);
			return {
				branch: b,
				outcome: "deferred",
				why: `risk tier ${risk.tier} needs ${risk.approvals} human approval(s)`,
			};
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
		// W2270: the publication grant is minted inside guardedMerge after the
		// final verifyReview PASS; without a store the grant cannot mint and
		// the reference-transaction hook fails the publish closed.
		let grantStore: ReturnType<typeof openStore> | undefined;
		try {
			grantStore = openStore();
		} catch {
			grantStore = undefined;
		}
		const mv = guardedMerge({
			repo: REPO,
			callerRepo: CALLER_REPO,
			branch: b,
			ladder: LADDER,
			timeoutMs: LADDER_TIMEOUT_MS,
			verifyReview,
			publishGrant: grantStore
				? {
						store: grantStore,
						project: projectIdentity(REPO),
						item: claim.item,
					}
				: undefined,
			// W2681: the W869 merge-time autofix runs INSIDE the guarded merge
			// (pre-publish, pre-review) — W2270 publish grants admit exactly
			// one reviewed fast-forward, so a separate post-merge fix commit
			// on main is structurally impossible.
			qltyFix: { branch: b },
		});
		grantStore?.close();
		let receipt: MergeReceipt;
		if (mv.code === 0) {
			const after = sh(["git", "rev-parse", "--short", "HEAD"]);
			log(`MERGED ${b} ${before}→${after}`);
			// W1476: the published head IS the landing — W2681 moved any qlty
			// autofix inside the guarded publish, so nothing moves `after`.
			const landed = after;
			clearStuck(STUCK, b);
			// W869 merge-time quality floor: the autofix ran INSIDE the
			// guarded merge (W2681) — its result rides the publish receipt.
			if (mv.qltyFix?.fixed) log(`QLTY-FIXED ${b} → ${mv.qltyFix.head}`);
			if (mv.qltyFix?.left)
				log(
					`QLTY-FIX-LEFT ${b}: ${mv.qltyFix.left} unfixable issue(s) — logged, never blocks`,
				);
			// W1228 landing invalidation: the merged diff flags matching
			// knowledge/facts stale-for-review and promotes the item's
			// finding.* facts — fail-open, never blocks a merge.
			try {
				const gov = openStore();
				try {
					const inv = withKnowledgeDb((kb) =>
						invalidateForLanding({
							repo: REPO,
							item: claim.item,
							sha: after,
							base: before,
							via: "merge",
							gov,
							kb,
						}),
					);
					if (inv)
						log(
							`KNOWLEDGE-STALE ${b}: ${inv.knowledge} row(s), ${inv.facts} fact(s) flagged; promoted: ${inv.promoted.join(", ") || "none"}`,
						);
				} finally {
					gov.close();
				}
			} catch (error) {
				log(`KNOWLEDGE-STALE-FAILED ${b} — ${String(error).slice(0, 200)}`);
			}
			// W1302.2 (A6): post-merge dangling-path scan — deleted paths still
			// referenced by live files, and unresolvable specifiers among the
			// merge's own delta. Fail-open: new edges bank into the one open
			// aggregate repair item (W1302.8); a scan failure never un-merges.
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
				for (const ref of dangling)
					log(
						`DANGLING-PATH ${b}: ${ref.target} referenced by ${ref.refBy}${ref.line ? `:${ref.line}` : ` (${ref.specifier})`}`,
					);
				const banked = bankDanglingRefs(REPO, "fleet-loop", dangling, after);
				if (dangling.length)
					log(
						`DANGLING-PATHS ${b}: ${dangling.length} finding(s), ${banked.length} new edge(s) banked`,
					);
				// W1762: a merge that touches the classifier files banks a
				// code.dangling-fix event when open repairs exist — the
				// dispatch hold releases on the INSTALLED receipt revision
				// containing this sha, never on a work item's DONE.
				const store = openStore();
				try {
					const openRepairs = store
						.query(
							"SELECT 1 FROM work_items WHERE project = ? AND title LIKE 'Repair dangling path %' AND state NOT IN ('DONE','CANCELLED','SUPERSEDED') LIMIT 1",
						)
						.get(projectIdentity(REPO));
					if (openRepairs && changed.some((f) => CLASSIFIER_PATHS.includes(f)))
						recordDanglingFix(store, projectIdentity(REPO), after);
				} finally {
					store.close();
				}
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
			// W1476: incidents become evals — a revert or incident landing banks
			// a review.incident event + an arena-case item. Fail-open.
			try {
				for (const line of reviewEvalsAfterMerge({
					repo: REPO,
					item: claim.item,
					before,
					landed,
					source: "fleet-loop",
				}))
					log(`${line} (${b})`);
			} catch (error) {
				log(
					`REVIEW-EVALS-FAILED ${b}: ${error instanceof Error ? error.message : String(error)}`,
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
				return {
					branch: b,
					outcome: "merged",
					head: after,
					why: `landing deferred: ${String(error).slice(0, 160)}`,
				};
			}
			clearFail(b);
			receipt = { branch: b, outcome: "merged", head: after };
		} else if (mv.tail.startsWith("review required:")) {
			log(`MERGE-DEFER ${b} — ${mv.tail}`);
			receipt = { branch: b, outcome: "deferred", why: mv.tail };
		} else {
			mergeFail(b, mv.tail);
			receipt = { branch: b, outcome: "failed", why: mv.tail };
		}
		try {
			rmSync(`${REPO}/.fleet/merge-active`);
		} catch {}
		// W1072.2: the hold defers retirement too — the branch just merged, but
		// its worktree/branch stay put while the operator owns the checkout.
		// W2561: the per-item defer keeps the same retirement hold.
		if (mergeHoldActive(REPO)) {
			log(`RETIRE-DEFER ${b} — operator merge hold, worktree/branch preserved`);
			return receipt;
		}
		if (mergeDeferredActive(REPO, b)) {
			log(`RETIRE-DEFER ${b} — per-item defer, worktree/branch preserved`);
			return receipt;
		}
		retireMerged(b);
		return receipt;
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
