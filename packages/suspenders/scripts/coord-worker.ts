#!/usr/bin/env bun
// coord-worker.ts — W529: the headless coordinator cadence. launchd label
// com.suspenders.coord-worker fires this entry every 900s (niced, no
// KeepAlive): mint the per-run bksk_ lane key (same belt-admin mint as
// dispatch, W463 fail-closed), write the 0600 settings file, spawn ONE
// governed headless claude session with the coordinator bootstrap
// (scripts/lib/coord-worker-decide.ts — drain inbox/consults, sweep the
// plane, at most ONE READY coordinator-class item, capsule checkpoints,
// exit), wait for it, revoke the key, exit. The interactive coordinator's
// warm transcript stands in front of the run (skip-live); a dead buckle
// front or a failed mint refuses the run (strict mode; next fire retries).
//
//   bun scripts/coord-worker.ts [--repo <dir>] [--timeout <s>] [--dry-run] [-h]
//
// env:   SUSPENDERS_COORD_MODEL             model pin for the run (default
//                                          matches dispatch-next's fallback)
//        SUSPENDERS_COORD_WORKER_TIMEOUT_S  hard run ceiling (default 3600)
//        SUSPENDERS_BUCKLE_FRONT            front override (lane.ts default)
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	COORD_WORKER_SID,
	COORDINATOR_SID_FACT,
	coordBootstrap,
	coordRunDecision,
	COORD_TAG,
} from "./lib/coord-worker-decide.ts";
import {
	adminKey,
	ensureLaneKey,
	laneKeyMetaPath,
	laneSettingsPath,
	retireLaneKey,
} from "./lib/lane-auth.ts";
import {
	applyLaneAttribution,
	laneEnv,
	probeBuckleFront,
	spawnClaude,
	DEFAULT_ALLOWED_TOOLS,
} from "./lib/lane.ts";
import { transcriptAlive } from "../hooks/lib/lane-liveness.ts";
import { canonicalProjectRoot } from "../hooks/lib/lane-registry.ts";

const argv = process.argv.slice(2);
if (import.meta.main && (argv.includes("--help") || argv.includes("-h"))) {
	console.log(`Usage: coord-worker [options]

One governed headless coordinator run (launchd com.suspenders.coord-worker, 900s interval): drain inbox/consults, at most one READY coordinator-class item (tagged #${COORD_TAG}), capsule, exit.

  --repo <dir>          Project checkout (default: git toplevel)
  --timeout <s>         Hard ceiling for the spawned session (default 3600)
  --dry-run             Probe + decide + print the bootstrap, no key, no spawn
  -h, --help            This help

Fails closed: buckle front down or key mint failed = refusal, exit 1.
The interactive coordinator's warm transcript (fact ${COORDINATOR_SID_FACT}) skips the run.`);
	process.exit(0);
}
const val = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes("--dry-run");

const gitToplevel = (): string => {
	const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = p.stdout ? new TextDecoder().decode(p.stdout).trim() : "";
	return out || process.cwd();
};
const REPO = canonicalProjectRoot(resolve(val("--repo") ?? gitToplevel()));
const FLEET = `${REPO}/.fleet`;
const BIN = `${process.env.SUSPENDERS_PREFIX ?? `${process.env.HOME}/.claude/hooks/suspenders`}/bin`;
const SID = COORD_WORKER_SID;
const MODEL = process.env.SUSPENDERS_COORD_MODEL ?? "glm-5.3-flash";
const TIMEOUT_S = Math.min(
	21_600,
	Math.max(
		300,
		Number(process.env.SUSPENDERS_COORD_WORKER_TIMEOUT_S ?? 3_600) || 3_600,
	),
);

const run = (
	cmd: string[],
): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};
const log = (msg: string): void => {
	mkdirSync(FLEET, { recursive: true });
	console.log(`${new Date().toISOString()} ${msg}`);
};

/** First line of `coord fact get <k>` — "(unset)" when absent. */
const factGet = (key: string): string | null => {
	const out = run([process.execPath, `${BIN}/coord.ts`, "fact", "get", key]);
	if (out.code !== 0) return null;
	const first = (out.out.split("\n")[0] ?? "").trim();
	return !first || first === "(unset)" ? null : first.replace(/\s*\(v\d+\)$/, "");
};

const main = async (): Promise<void> => {
	// the interactive coordinator stands in front of this fire (its transcript
	// warm ≤15 min = coordination covered); absent/stale fact = worker's turn
	const coordSid = factGet(COORDINATOR_SID_FACT);
	const coordinatorLive = coordSid !== null && transcriptAlive(coordSid);
	// governed path probes BEFORE anything is written: strict, no override —
	// the worker exists to keep coordination under governance, never beside it
	const frontUp = (await probeBuckleFront()) !== null;
	// dry-run never mints; the sentinel keeps the decision matrix honest about
	// everything else (a null here would read as a mint FAILURE, not a skip)
	const minted = DRY
		? { key: "bksk_dry-run-sentinel", keyId: "dry-run" }
		: await ensureLaneKey(SID);
	const decision = coordRunDecision({
		coordinatorLive,
		frontUp,
		minted,
	});
	if (decision.mode !== "run") {
		log(
			`${decision.mode === "skip-live" ? "SKIP" : "REFUSED"} ${SID} — ${decision.why}`,
		);
		if (decision.mode === "refuse") process.exitCode = 1;
		return;
	}
	if (!minted) return; // unreachable — decision gates it; satisfies the type check
	const bootstrap = coordBootstrap({ sid: SID, repo: REPO, bin: BIN, model: MODEL });
	if (DRY) {
		console.log(bootstrap);
		log(`DRY RUN — decision: run (front up, mint skipped); bootstrap above`);
		return;
	}
	const env = laneEnv({ ...process.env });
	applyLaneAttribution(env, SID);
	env.ANTHROPIC_AUTH_TOKEN = minted.key;
	env.SUSPENDERS_SID = SID;
	env.SUSPENDERS_SESSION_IDENTITY_PROTOCOL = "canonical-v1";
	// same 0600 pair as dispatch (W463): key meta for revoke-audit, settings
	// for the model pin + front base URLs (settings.json env clobbers process
	// env — the file outranks it)
	writeFileSync(
		laneKeyMetaPath(FLEET, SID),
		`${JSON.stringify({ sid: SID, key_id: minted.keyId, mintedAt: Date.now() }, null, 2)}\n`,
	);
	chmodSync(laneKeyMetaPath(FLEET, SID), 0o600);
	const settings = `${JSON.stringify(
		{
			env: {
				ANTHROPIC_MODEL: "opus",
				ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
				ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
				ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
				ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
				ANTHROPIC_AUTH_TOKEN: minted.key,
			},
		},
		null,
		2,
	)}\n`;
	writeFileSync(laneSettingsPath(FLEET, SID), settings);
	chmodSync(laneSettingsPath(FLEET, SID), 0o600);
	const laneLog = `${FLEET}/lane-${SID}.log`;
	log(
		`RUN ${SID} — coordinator session starting (model ${MODEL}, ceiling ${TIMEOUT_S}s, log ${laneLog})`,
	);
	// spawn + WAIT: unlike dispatch (daemonize, forget), the worker owns the
	// run — launchd's StartInterval coalesces fires while this one lives, so
	// the cadence self-serializes around the session
	const proc = spawnClaude({
		bin: process.env.SUSPENDERS_CLAUDE_BIN ?? "claude",
		prompt: bootstrap,
		cwd: REPO,
		logFile: laneLog,
		env,
		cliArgs: [
			"--allowedTools",
			DEFAULT_ALLOWED_TOOLS,
			"--permission-mode",
			"acceptEdits",
			"--settings",
			laneSettingsPath(FLEET, SID),
		],
		agent: "claude",
		fleetDir: FLEET,
	});
	const exitCode = await Promise.race([
		proc.exited,
		Bun.sleep(TIMEOUT_S * 1000).then(() => null),
	]);
	if (exitCode === null) {
		log(`TIMEOUT ${SID} — ${TIMEOUT_S}s ceiling hit, killing the session`);
		proc.kill();
		const second = await Promise.race([
			proc.exited,
			Bun.sleep(30_000).then(() => null),
		]);
		if (second === null) proc.kill(9);
		await proc.exited;
	}
	// terminal cleanup (W463): revoke the run's key, remove the 0600 files
	const retired = await retireLaneKey({ fleet: FLEET, sid: SID });
	log(
		`EXIT ${SID} — session exit ${exitCode ?? `timeout${retired.revoked ? ", key revoked" : ", key revoke failed (TTL bounds it)"}`}`,
	);
	if (exitCode !== 0 && exitCode !== null) process.exitCode = 1;
};

if (import.meta.main) {
	await main();
}
