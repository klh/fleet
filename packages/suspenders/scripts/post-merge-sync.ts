#!/usr/bin/env bun
// post-merge-sync.ts — the W821 post-merge runtime sync runner: publish the
// merged main into the installed prefix (install.ts --step syncHarness --yes)
// and kickstart only the serve surfaces whose packages the drift range
// touched. Ride-along of the fleet-loop cycle (hooks/lib/fleet-loop/
// runtime-sync.ts), spawned as a child so a slow sync can never hang the
// loop; equally runnable by hand for install-grade verification:
//
//   bun scripts/post-merge-sync.ts --check            # decision only, no writes
//   bun scripts/post-merge-sync.ts                    # sync + kicks (if drifted)
//   bun scripts/post-merge-sync.ts --skip-kick        # publish, restart nothing
//
// Guards: stamp drift is the only trigger (idempotent; a failed sync never
// advances the stamp, the next cycle retries); syncHarness itself refuses a
// dirty payload (W780) — committed reviewed code only; kicks run only after
// a successful publish (never restart services onto an unsynced prefix) and
// only where a proven package change demands one. Exit 0 synced/up-to-date/
// waiting · 1 sync failed.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fleetRootOf } from "./lib/auto-install.ts";
import {
	parseBudgetMs,
	readPostMergeStamp,
} from "./lib/activation-readiness.ts";
import { appendLog, buildPostMergeDeps } from "./lib/post-merge-live.ts";
import { runPostMergeSync } from "./lib/post-merge-runner.ts";
import { decideRuntimeSync } from "./lib/runtime-sync.ts";

const USAGE = `Usage: post-merge-sync.ts [--repo <packages/suspenders path>] [options]

The W2546 post-merge runtime sync: syncHarness the installed prefix from the
pinned checkout when fleet main moved past the last-synced stamp, then
activate only the serve surfaces (belt-swarm, belt dashboard, buckle-spoke,
board) whose packages the drift range touched. Publication and activation
are SEPARATE successes: the stamp's activation ledger records verified /
kickFailed / unready / needsReviewedUpgrade per label, and a published-but-
unverified stamp never reads "up-to-date" — the next cycle retries exactly
the missing labels.

  --repo <path>       package root to sync FROM (required, or
                      SUSPENDERS_REPO env — the fleet-loop sweep passes the
                      pinned checkout's packages/suspenders)
  --state <path>      stamp file (default
                      ~/.local/state/suspenders/post-merge-sync.json)
  --check             evaluate the decision, print JSON, change nothing
  --skip-kick         publish without activating any label (recorded in the
                      stamp; the sweep catches the activation up after a
                      bounded holdoff)
  --budget-ms <n>     per-label readiness budget in ms (default 30000)
  --log <path>        log file (default ~/.claude-insights/post-merge-sync.log)
  -h, --help          this help

Exit codes: 0 settled / up-to-date / waiting / honest --skip-kick · 1 sync
failed (stamp untouched, will retry) · 2 activation incomplete (the stamp
carries the truthful partial ledger: verified / kickFailed / unready /
needsReviewedUpgrade).`;

const STATE_DEFAULT = `${homedir()}/.local/state/suspenders/post-merge-sync.json`;
const LOG_DEFAULT = `${homedir()}/.claude-insights/post-merge-sync.log`;

const log = (msg: string): void => {
	console.log(`${new Date().toISOString()} ${msg}`);
};

const sh = (cmd: string[], cwd?: string): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`,
	};
};

const flagValue = (name: string): string | undefined => {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

const hasFlag = (name: string): boolean => process.argv.slice(2).includes(name);

const main = (): number => {
	if (hasFlag("-h") || hasFlag("--help")) {
		console.log(USAGE);
		return 0;
	}
	const repo = flagValue("--repo") ?? process.env.SUSPENDERS_REPO;
	if (repo === undefined || repo === "" || !existsSync(repo)) {
		log(`refused: --repo missing or not a dir (${repo ?? "unset"})`);
		return 1;
	}
	const fleetRoot = fleetRootOf(repo);
	const statePath = flagValue("--state") ?? STATE_DEFAULT;
	const logPath = flagValue("--log") ?? LOG_DEFAULT;
	const checkOnly = hasFlag("--check");
	const skipKick = hasFlag("--skip-kick");
	// NaN/Infinity/junk/≤0 refuse loudly (N2-budget-nan): a NaN deadline made
	// every poll's budget compare false — a transport-failure poll hung the
	// sync child forever instead of exhausting truthfully.
	const budgetRaw = flagValue("--budget-ms");
	const budgetMs = parseBudgetMs(budgetRaw);
	if (budgetMs === null) {
		log(`refused: --budget-ms must be a finite positive number (${budgetRaw})`);
		return 1;
	}

	const head = sh(["git", "-C", fleetRoot, "rev-parse", "main"]);
	const headSha = head.code === 0 ? head.out.trim() || null : null;
	const stamp = readPostMergeStamp(
		existsSync(statePath) ? readFileSync(statePath, "utf8") : null,
	);
	const paths = stamp?.main
		? sh([
				"git",
				"-C",
				fleetRoot,
				"diff",
				"--name-only",
				`${stamp.main}..${headSha ?? ""}`,
			])
		: { code: 0, out: "" };
	const driftPaths =
		stamp?.main && paths.code === 0
			? paths.out.split("\n").filter((l) => l.trim() !== "")
			: null;
	const decision = decideRuntimeSync({
		head: headSha,
		stamp,
		paths: driftPaths,
	});

	if (checkOnly) {
		console.log(
			JSON.stringify({
				decision,
				head: headSha,
				stamp: stamp?.main ?? null,
				activation: stamp?.activation
					? {
							verified: stamp.activation.verified.length,
							kickFailed: stamp.activation.kickFailed.length,
							unready: stamp.activation.unready.length,
							needsReviewedUpgrade:
								stamp.activation.needsReviewedUpgrade.length,
						}
					: null,
				paths: driftPaths?.length ?? null,
			}),
		);
		return 0;
	}
	if (decision.action === "skip") {
		log(`waiting: ${decision.reason} (head ${headSha ?? "?"})`);
		return 0;
	}

	log(
		`syncing main ${headSha} (labels: ${decision.labels.length > 0 ? decision.labels.join(",") : "none"})`,
	);
	const deps = buildPostMergeDeps(repo, statePath, logPath);
	const result = runPostMergeSync(deps, {
		head: headSha ?? "",
		labels: decision.labels,
		prior: stamp,
		skipKick,
		readinessBudgetMs: budgetMs,
	});
	appendLog(
		logPath,
		`exit ${result.exit} — ${result.activation?.note ?? "publication failed"}`,
	);
	return result.exit;
};

process.exit(main());
