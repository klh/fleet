#!/usr/bin/env bun
// lane-guard.ts — W1141 resident runner: BOTH lane-guard proxies in one
// process. Registered in deploy/services.yaml as `lane-guard` (com.suspenders
// .lane-guard, keepalive); ports resolve via flags > env > the defaults.
//
//   bun <prefix>/bin/lane-guard.ts [--repo <repoRoot>] [--egress-port N]
//       [--push-port N]
//
// The egress proxy runs only when the machine conf carries an egress allow
// list (absent conf = inert — nothing to enforce); the push proxy always
// runs — without a minted identity a push is refused 401, so an unconfigured
// machine simply has a dark-but-present front. --help exits 0.
import { laneEgressLogFile, loadLaneGuardConf } from "../lib/lane-guard.ts";
import {
	LANE_GUARD_EGRESS_PORT,
	LANE_GUARD_PUSH_PORT,
} from "../lib/lane-guard.ts";
import {
	startLaneEgressProxy,
	startLanePushProxy,
} from "../lib/lane-guard-proxy.ts";

const val = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};

const num = (name: string, envName: string, fallback: number): number => {
	const v = val(name) ?? process.env[envName];
	if (!v) return fallback;
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** The real origin URL for a repo root — the shared fetch URL, never a
 *  worktree's pinned pushurl (that would relay proxy → proxy). */
const originOf = (repo: string): string => {
	const p = Bun.spawnSync(["git", "-C", repo, "remote", "get-url", "origin"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return p.exitCode === 0 ? p.stdout.toString().trim() : "";
};

if (import.meta.main) {
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: lane-guard.ts [--repo <repoRoot>] [--egress-port N] [--push-port N]\n\nResident lane guard (W1141): the egress CONNECT/forward proxy (:7817) + the git push scoping front (:7818) in one process. Repo root defaults to cwd. Env: LANE_GUARD_EGRESS_PORT / LANE_GUARD_PUSH_PORT.",
		);
		process.exit(0);
	}
	const repo = val("--repo") ?? process.cwd();
	const conf = loadLaneGuardConf();
	const push = startLanePushProxy({
		port: num("--push-port", "LANE_GUARD_PUSH_PORT", LANE_GUARD_PUSH_PORT),
		repoRoot: repo,
		originUrl: originOf(repo),
	});
	console.log(
		`lane-guard push front on 127.0.0.1:${push.port} (origin ${originOf(repo)})`,
	);
	if (conf?.egress?.allow?.length) {
		const egress = startLaneEgressProxy({
			port: num(
				"--egress-port",
				"LANE_GUARD_EGRESS_PORT",
				LANE_GUARD_EGRESS_PORT,
			),
			allow: conf.egress.allow,
			logFile: laneEgressLogFile(conf),
		});
		console.log(
			`lane-guard egress proxy on 127.0.0.1:${egress.port} (${conf.egress.allow.length} allowlisted hosts)`,
		);
	} else {
		console.log(
			"lane-guard egress: no allowlist in conf — inert (not started)",
		);
	}
}
