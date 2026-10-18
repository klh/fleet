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
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fleetRootOf, readStamp, writeStamp } from "./lib/auto-install.ts";
import { decideRuntimeSync } from "./lib/runtime-sync.ts";

const USAGE = `Usage: post-merge-sync.ts [--repo <packages/suspenders path>] [options]

The W821 post-merge runtime sync: syncHarness the installed prefix from the
pinned checkout when fleet main moved past the last-synced stamp, then
kickstart only the serve surfaces (belt-swarm, belt dashboard, buckle-spoke,
board) whose packages the drift range touched.

  --repo <path>       package root to sync FROM (required, or
                      SUSPENDERS_REPO env — the fleet-loop sweep passes the
                      pinned checkout's packages/suspenders)
  --state <path>      stamp file (default
                      ~/.local/state/suspenders/post-merge-sync.json)
  --check             evaluate the decision, print JSON, change nothing
  --skip-kick         publish without kickstarting any label
  --log <path>        log file (default ~/.claude-insights/post-merge-sync.log)
  -h, --help          this help

Exit codes: 0 synced / up-to-date / waiting, 1 sync failed.`;

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

	const head = sh(["git", "-C", fleetRoot, "rev-parse", "main"]);
	const headSha = head.code === 0 ? head.out.trim() || null : null;
	const stamp = readStamp(statePath);
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
		stamp: stamp?.main ?? null,
		paths: driftPaths,
	});

	if (checkOnly) {
		console.log(
			JSON.stringify({
				decision,
				head: headSha,
				stamp: stamp?.main ?? null,
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
	const install = sh(
		[
			process.execPath,
			join(repo, "scripts/install.ts"),
			"--step",
			"syncHarness",
			"--yes",
		],
		repo,
	);
	if (install.code !== 0) {
		const tail = install.out
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-5)
			.join(" | ");
		appendFileSync(
			logPath,
			`${new Date().toISOString()} syncHarness FAILED rc=${install.code} (main ${headSha}): ${tail}\n`,
		);
		log(`sync failed rc=${install.code} — stamp not advanced, will retry`);
		return 1;
	}
	writeStamp(statePath, headSha ?? "");
	appendFileSync(
		logPath,
		`${new Date().toISOString()} synced main ${headSha}\n`,
	);

	if (skipKick || decision.labels.length === 0) {
		log(
			`synced (kicks: skipped${decision.labels.length > 0 ? " by flag" : ""})`,
		);
		return 0;
	}
	if (process.platform !== "darwin") {
		log(
			`synced; kicks skipped: not darwin (labels ${decision.labels.join(",")})`,
		);
		return 0;
	}
	for (const label of decision.labels) {
		const kick = sh([
			"/bin/launchctl",
			"kickstart",
			"-k",
			`gui/${process.getuid()}/${label}`,
		]);
		appendFileSync(
			logPath,
			`${new Date().toISOString()} kickstart ${label} rc=${kick.code} ${kick.out.trim().slice(-200)}\n`,
		);
		log(`kickstart ${label} rc=${kick.code}`);
	}
	return 0;
};

process.exit(main());
