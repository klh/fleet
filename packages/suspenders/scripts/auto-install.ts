#!/usr/bin/env bun
// auto-install.ts — the W638 com.suspenders.auto-install launchd runner
// (deploy/services.yaml, 300s interval): install.sh runs when fleet main
// moved past the last-installed stamp AND the repo volume is mounted AND no
// lane is live/unknown (the harness sync mutates code running lanes execute
// — the 2026-10-11 outage class). Action = plain `bash install.sh` (no
// --with-launchd: no unit re-registration, no restarts) + log; on success
// the stamp advances and ONE `dispatch registry prune --all-dead` (W636)
// clears ghosts the old runtime left. Skips are waiting states — the next
// tick re-evaluates; a failed install never advances the stamp.
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import {
	decideAutoInstall,
	fleetRootOf,
	installScriptDir,
	isVolumeMounted,
	readStamp,
	writeStamp,
} from "./lib/auto-install.ts";

const USAGE = `Usage: auto-install.ts [--repo <packages/suspenders path>] [options]

The com.suspenders.auto-install launchd agent: refresh the installed harness
from the pinned checkout when fleet main moves and no lane can be hurt.

  --repo <path>       package root to install FROM (required, or
                      SUSPENDERS_REPO env — the services.yaml render passes
                      the pinned checkout's packages/suspenders)
  --state <path>      stamp file (default
                      ~/.local/state/suspenders/auto-install.json)
  --check             evaluate the guards, print the decision, change nothing
  --force             ignore the stamp (still honors volume + lanes guards)
  --skip-prune        skip the post-install dispatch registry prune
  -h, --help          this help

Exit codes: 0 installed / up-to-date / waiting, 1 install failed.

Deployment: deploy/services.yaml entry "auto-install" — rendered by
registerLaunchd into com.suspenders.auto-install.plist; activate with
install.sh --with-launchd.`;

const PREFIX =
	process.env.SUSPENDERS_PREFIX ?? `${homedir()}/.claude/hooks/suspenders`;
const STATE_DEFAULT = `${homedir()}/.local/state/suspenders/auto-install.json`;
const WORK_BIN = `${PREFIX}/bin/work.ts`;
const DISPATCH_CLI = `${PREFIX}/scripts/dispatch-next.ts`;

const log = (msg: string): void => {
	console.log(`${new Date().toISOString()} ${msg}`);
};

const sh = (cmd: string[], cwd: string): { code: number; out: string } => {
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
	const logPath =
		flagValue("--log") ?? `${homedir()}/.claude-insights/auto-install.log`;
	const force = hasFlag("--force");
	const checkOnly = hasFlag("--check");

	const volumeMounted = isVolumeMounted(fleetRoot);
	const head = sh(["git", "-C", fleetRoot, "rev-parse", "main"], fleetRoot);
	const headSha = head.code === 0 ? head.out.trim() || null : null;
	const stamp = force ? null : readStamp(statePath);
	const lanes = parseLanes(
		sh([process.execPath, WORK_BIN, "lanes", "--json"], fleetRoot),
	);

	const decision = decideAutoInstall({
		volumeMounted,
		head: headSha,
		stamp: stamp?.main ?? null,
		lanes,
	});

	if (checkOnly) {
		console.log(
			JSON.stringify({
				decision,
				head: headSha,
				stamp: stamp?.main ?? null,
				lanes: lanes?.length ?? null,
			}),
		);
		return 0;
	}
	if (decision.action === "skip") {
		log(`waiting: ${decision.reason} (head ${headSha ?? "?"})`);
		return 0;
	}

	log(`installing main ${headSha} (lanes clear, volume mounted)`);
	appendFileSync(
		logPath,
		`${new Date().toISOString()} install.sh start (main ${headSha})\n`,
	);
	// W1243: the caller may pass the fleet root where install.sh does not
	// live (the W779 heartbeat used to) — fall back to the package root
	// instead of a 127-forever tick.
	const installDir = installScriptDir(repo);
	const install = Bun.spawnSync(["bash", "install.sh"], {
		cwd: installDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((install.exitCode ?? 1) !== 0) {
		appendFileSync(
			logPath,
			`${new Date().toISOString()} install.sh FAILED rc=${install.exitCode} (main ${headSha})\n`,
		);
		return 1;
	}
	writeStamp(statePath, headSha ?? "");
	appendFileSync(
		logPath,
		`${new Date().toISOString()} installed main ${headSha}\n`,
	);

	if (hasFlag("--skip-prune")) return 0;
	const prune = sh(
		[process.execPath, DISPATCH_CLI, "registry", "prune", "--all-dead"],
		fleetRoot,
	);
	appendFileSync(
		logPath,
		`${new Date().toISOString()} registry prune rc=${prune.code} ${prune.out.trim().slice(-400)}\n`,
	);
	return 0;
};

const parseLanes = (result: {
	code: number;
	out: string;
}): { sid: string; live: boolean | null }[] | null => {
	if (result.code !== 0) return null;
	try {
		const parsed = JSON.parse(result.out) as unknown;
		return Array.isArray(parsed)
			? parsed.filter(
					(r): r is { sid: string; live: boolean | null } =>
						typeof (r as { sid?: unknown })?.sid === "string",
				)
			: null;
	} catch {
		return null;
	}
};

process.exit(main());
