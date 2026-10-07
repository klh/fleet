#!/usr/bin/env bun
// dispatch-watchdog.ts — the supervisor's supervisor (2026-10-06 outage class).
// Every 5 minutes (launchd interval), probe the four failure points that
// silently stalled crunching today, repair what is repairable, and SAY SO:
//
//   1. prefix-lib parity — prefix bin/* import ../../scripts/lib/*.ts (W463);
//      a missing/stale copy crash-loops fleet-loop while launchd keeps it
//      "running". Repair = bash install.sh --no-llm (the installer is the
//      ONLY repo→prefix sync; the watchdog never hand-cps).
//   2. fleet-loop liveness — same-pid stability across checks; a churning pid
//      (crash-loop) or no pid at all → kickstart.
//   3. work flow — project graph completions + process-backed live lanes;
//      dead claimed backlog is pending, dispatch chatter is not progress.
//   4. governed-path probe — mint a throwaway lane key and push one tiny
//     inference through the :4101 front; the end-to-end proof lanes depend on.
//
// Every verdict lands in .fleet/dispatch-watchdog.log; repairs + probe
// failures broadcast on the coord bus so the fleet sees the outage.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { laneToolRoundtrip } from "./lib/lane-tool-probe.ts";
import {
	fleetProgress,
	type ProgressState,
	type WorkStats,
} from "./lib/fleet-progress.ts";

const HOME = process.env.HOME ?? "";
const REPO =
	process.env.SUSPENDERS_WATCHDOG_REPO ?? "/Volumes/Sensitive/github/klh/fleet";
const PREFIX =
	process.env.SUSPENDERS_PREFIX ?? `${HOME}/.claude/hooks/suspenders`;
const FLEET = process.env.SUSPENDERS_FLEET_DIR ?? `${REPO}/.fleet`;
const SID = process.env.SUSPENDERS_WATCHDOG_SID ?? "watchdog";

const statePath = join(FLEET, "dispatch-watchdog.json");
const logPath = join(FLEET, "dispatch-watchdog.log");

const log = (msg: string): void => {
	appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
};

const sh = (cmd: string[], cwd = REPO): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`.trim(),
	};
};

// ---------- 1. prefix-lib parity ----------
const libParity = (): { ok: boolean; missing: string[] } => {
	const srcDir = join(REPO, "packages/suspenders/scripts/lib");
	const depths = [join(PREFIX, "scripts/lib"), join(PREFIX, "../scripts/lib")];
	const missing: string[] = [];
	if (!existsSync(srcDir))
		return { ok: false, missing: ["repo scripts/lib gone"] };
	for (const f of sh(["/bin/ls", srcDir])
		.out.split("\n")
		.filter((f) => f.endsWith(".ts"))) {
		for (const d of depths) {
			const p = join(d, f);
			if (!existsSync(p)) missing.push(p);
			else if (!readFileSync(p).equals(readFileSync(join(srcDir, f))))
				missing.push(`${p} (stale bytes)`);
		}
	}
	return { ok: missing.length === 0, missing };
};

// ---------- 2. fleet-loop liveness ----------
const loopPid = (): number | null => {
	const out = sh(["launchctl", "list"]).out;
	const line = out
		.split("\n")
		.find((l) => l.includes("com.suspenders.fleet-loop"));
	if (!line) return null;
	const pid = Number.parseInt(line.split("\t")[0], 10);
	return Number.isFinite(pid) && pid > 0 ? pid : null;
};

// ---------- 3. dispatch flow ----------
const progressSnapshot = (): { stats: WorkStats; live: number } => {
	const stats = sh([process.execPath, `${PREFIX}/bin/work.ts`, "stats"]);
	const lanes = sh([
		process.execPath,
		`${PREFIX}/bin/work.ts`,
		"lanes",
		"--json",
	]);
	if (stats.code !== 0 || lanes.code !== 0)
		throw new Error("work progress/liveness unavailable");
	return {
		stats: JSON.parse(stats.out),
		live: (JSON.parse(lanes.out) as { live: boolean }[]).filter((l) => l.live)
			.length,
	};
};

// ---------- 4. governed-path probe ----------
const laneProbe = async (): Promise<{ ok: boolean; detail: string }> => {
	const beltEnv = `${HOME}/.claude/local-llm/belt.env`;
	if (!existsSync(beltEnv)) return { ok: false, detail: "belt.env missing" };
	const env = Object.fromEntries(
		readFileSync(beltEnv, "utf8")
			.split("\n")
			.filter((l) => l.includes("=") && !l.trim().startsWith("#"))
			.map((l) => [
				l.slice(0, l.indexOf("=")).trim(),
				l.slice(l.indexOf("=") + 1).trim(),
			]),
	);
	const admin = env.BUCKLE_ADMIN_KEY;
	if (!admin) return { ok: false, detail: "BUCKLE_ADMIN_KEY unset" };
	const mint = await fetch("http://127.0.0.1:4101/v1/admin/keys", {
		signal: AbortSignal.timeout(10_000),
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${admin}`,
		},
		body: JSON.stringify({
			name: `${SID}-probe`,
			scopes: ["buckle:proxy:WRITE_"],
			expires_in_s: 300,
		}),
	});
	const mb = (await mint.json().catch(() => ({}))) as {
		key?: string;
		key_id?: string;
	};
	if (!mint.ok || !mb.key || !mb.key_id)
		return { ok: false, detail: `mint failed ${mint.status}` };
	try {
		return await laneToolRoundtrip(async (body) => {
			const r = await fetch(
				"http://127.0.0.1:4101/w/watchdog-probe/v1/messages",
				{
					method: "POST",
					signal: AbortSignal.timeout(25_000),
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${mb.key}`,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify(body),
				},
			);
			if (!r.ok) throw new Error(`lane front HTTP ${r.status}`);
			return await r.json();
		});
	} finally {
		await fetch(`http://127.0.0.1:4101/v1/admin/keys/${mb.key_id}/revoke`, {
			method: "POST",
			signal: AbortSignal.timeout(10_000),
			headers: { authorization: `Bearer ${admin}` },
		}).catch(() => {});
	}
};

// ---------- 5. memory guard (W500) ----------
// The crash valve lives OUTSIDE belt (health-is-outside-process): wired past
// the guard band or litellm ballooning are the OOM precursors — act, don't
// just verdict. The always-exempt set is minimal tier's ≤4GB residents
// (residentSet() minimal in belt bin/registry.ts); everything else MLX is
// reapable when wired crosses the band.
const WIRED_GUARD_GB = 60;
const LITELLM_RSS_GUARD_GB = 4;
const EXEMPT_PORTS = new Set([8902, 8913]);

const wiredNowGb = (): number => {
	const out = sh(["/usr/bin/vm_stat"]).out;
	const m = /Pages wired down:\s+(\d+)/.exec(out);
	return m ? (Number(m[1]) * 16384) / 2 ** 30 : -1;
};

const portRssGb = (port: number): number => {
	const pid = sh([
		"/usr/sbin/lsof",
		"-ti",
		`tcp:${port}`,
		"-sTCP:LISTEN",
	]).out.split("\n")[0];
	if (!pid) return 0;
	const kb = Number.parseInt(
		sh(["/bin/ps", "-o", "rss=", "-p", pid]).out.trim(),
		10,
	);
	return Number.isFinite(kb) ? kb / 1048576 : 0;
};

const reapHeaviestMlx = (): string => {
	const out = sh(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]).out;
	const rows: { port: number; pid: number; rss: number }[] = [];
	for (const line of out.split("\n")) {
		const m = /^\S+\s+(\d+)\s+\S+\s+.*127\.0\.0\.1:(890\d|891\d)\s/.exec(line);
		if (!m) continue;
		const port = Number.parseInt(m[2], 10);
		if (EXEMPT_PORTS.has(port)) continue;
		rows.push({ port, pid: Number(m[1]), rss: portRssGb(port) });
	}
	if (rows.length === 0) return "no reapable MLX listener";
	rows.sort((a, b) => b.rss - a.rss);
	const h = rows[0];
	sh(["/bin/kill", "-9", String(h.pid)]);
	return `killed :${h.port} pid ${h.pid} (${h.rss.toFixed(1)}GB)`;
};

// ---------- repair + report ----------
const emit = (kind: string, note: string): void => {
	sh([
		process.execPath,
		`${PREFIX}/bin/coord.ts`,
		"emit",
		kind,
		"--scope",
		"suspenders",
		"--as",
		SID,
		"--note",
		note.slice(0, 900),
	]);
};

const readState = (): ProgressState & { loopPid: number | null } => {
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return { loopPid: null };
	}
};

const run = async (): Promise<number> => {
	const verdicts: string[] = [];
	let repaired = false;

	// 1. lib parity (+ repair via the installer)
	const parity = libParity();
	if (!parity.ok) {
		log(`REPAIR lib parity broken: ${parity.missing.join(", ")}`);
		const install = sh([
			"/bin/bash",
			join(REPO, "packages/suspenders/install.sh"),
			"--no-llm",
			"--skip-models",
		]);
		const verified = install.code === 0 && libParity().ok;
		repaired = verified;
		verdicts.push(
			`lib-parity ${verified ? "REPAIRED" : "FAILED"} via installer`,
		);
		emit(
			verified ? "BROADCAST" : "NEED_DECISION",
			verified
				? "dispatch-watchdog repaired and reverified installed helper parity"
				: "dispatch-watchdog installer/parity verification failed; inspect install logs before retrying",
		);
	} else verdicts.push("lib-parity ok");

	// 2. loop liveness (pid stability across runs)
	const pid = loopPid();
	const previous = readState();
	const prev = previous.loopPid;
	let kicked = false;
	if (pid === null) {
		sh([
			"launchctl",
			"kickstart",
			"-k",
			`gui/${process.getuid()}/com.suspenders.fleet-loop`,
		]);
		repaired = true;
		kicked = true;
		verdicts.push("fleet-loop DOWN → kickstarted");
		emit(
			"BROADCAST",
			"dispatch-watchdog kickstarted com.suspenders.fleet-loop (no live pid)",
		);
	} else if (prev !== null && prev !== pid) {
		verdicts.push(
			`fleet-loop pid churn ${prev}→${pid} — crash-loop suspected, kickstarting`,
		);
		sh([
			"launchctl",
			"kickstart",
			"-k",
			`gui/${process.getuid()}/com.suspenders.fleet-loop`,
		]);
		repaired = true;
		kicked = true;
		emit(
			"BROADCAST",
			`dispatch-watchdog saw fleet-loop pid churn (${prev}→${pid}) — kickstarted; check /tmp/fleet-loop.log for the crash cause`,
		);
	} else verdicts.push(`fleet-loop ok pid=${pid}`);
	// 3. Project graph/liveness, never dispatch-log timestamps.
	let nextState: ProgressState = previous;
	try {
		const snapshot = progressSnapshot();
		const flow = fleetProgress(
			snapshot.stats,
			snapshot.live,
			previous,
			Date.now(),
		);
		nextState = flow.state;
		verdicts.push(
			`work flow ${flow.stalled ? "STALLED" : flow.pending === 0 ? "idle" : "active/watching"} (pending=${flow.pending}, live=${flow.live}, done=${flow.state.done})`,
		);
		if (flow.restart && !kicked) {
			const kick = sh([
				"launchctl",
				"kickstart",
				"-k",
				`gui/${process.getuid()}/com.suspenders.fleet-loop`,
			]);
			if (kick.code === 0) {
				kicked = true;
				repaired = true;
				nextState.progressRestarts = (nextState.progressRestarts ?? 0) + 1;
				nextState.restartAt = Date.now();
				emit(
					"BROADCAST",
					`dispatch-watchdog: stalled graph with ${flow.pending} pending and zero live lanes; recovery kick ${nextState.progressRestarts}/2`,
				);
			} else verdicts.push("stalled recovery kick failed");
		} else if (flow.stalled && (nextState.progressRestarts ?? 0) >= 2) {
			emit(
				"NEED_DECISION",
				"Fleet work remains stalled after two recovery kicks; inspect dead claims/routes before another retry.",
			);
		}
	} catch {
		verdicts.push("work flow UNKNOWN: structured graph/liveness unavailable");
		emit(
			"NEED_DECISION",
			"Watchdog cannot verify graph progress; restore structured work stats/liveness.",
		);
	}
	// All kick paths adopt the fresh PID next run, including progress recovery.
	writeFileSync2(
		statePath,
		JSON.stringify({
			...nextState,
			loopPid: kicked ? null : pid,
			at: new Date().toISOString(),
		}),
	);

	// 4. governed-path probe — a DOWN front must verdict, never crash the
	// watchdog (the post-reboot run exited 1 with the spoke down: the mint
	// fetch rejected unhandled).
	let probe: { ok: boolean; detail: string };
	try {
		probe = await laneProbe();
	} catch (e) {
		probe = { ok: false, detail: `probe threw: ${String(e).slice(0, 120)}` };
	}
	verdicts.push(`lane probe ${probe.ok ? "ok" : `FAIL: ${probe.detail}`}`);

	// 5. memory guard (W500) — act on OOM precursors, never crash on them.
	const wired = wiredNowGb();
	if (wired >= 0) {
		if (wired > WIRED_GUARD_GB) {
			const action = reapHeaviestMlx();
			verdicts.push(
				`memory GUARD: wired ${wired.toFixed(0)}GB > ${WIRED_GUARD_GB}GB → ${action}`,
			);
			emit(
				"BROADCAST",
				`dispatch-watchdog memory guard: wired ${wired.toFixed(0)}GB — ${action}; recurrence = the tier/spawn guards need review`,
			);
			repaired = true;
		} else verdicts.push(`memory ok (wired ${wired.toFixed(0)}GB)`);
		const litellmGb = portRssGb(4100);
		if (litellmGb > LITELLM_RSS_GUARD_GB) {
			const pid = sh([
				"/usr/sbin/lsof",
				"-ti",
				"tcp:4100",
				"-sTCP:LISTEN",
			]).out.trim();
			if (pid) sh(["/bin/kill", "-9", ...pid.split("\n")]);
			verdicts.push(
				`litellm RSS ${litellmGb.toFixed(1)}GB > ${LITELLM_RSS_GUARD_GB}GB → killed :4100 (supervisor revives)`,
			);
			emit(
				"BROADCAST",
				`dispatch-watchdog restarted litellm (:4100 RSS ${litellmGb.toFixed(1)}GB — retry-storm buffering class)`,
			);
			repaired = true;
		}
	}
	if (!probe.ok) {
		emit(
			"NEED_DECISION",
			`dispatch-watchdog: governed lane path FAILING — ${probe.detail}. Lanes will die on first inference; check buckle :4101 + the ladder locals.`,
		);
	}

	log(verdicts.join(" | "));
	if (repaired) console.log(`watchdog: repaired (${verdicts.join(" | ")})`);
	else console.log(`watchdog: ${verdicts.join(" | ")}`);
	return 0;
};

// writeFileSync with parents
function writeFileSync2(p: string, data: string): void {
	const { mkdirSync, writeFileSync } = require("node:fs");
	mkdirSync(FLEET, { recursive: true });
	writeFileSync(p, data);
}

const dry = process.argv.includes("--dry-run");
if (dry) {
	const parity = libParity();
	const pid = loopPid();
	const snapshot = progressSnapshot();
	const flow = fleetProgress(
		snapshot.stats,
		snapshot.live,
		readState(),
		Date.now(),
	);
	console.log(
		`dry: lib-parity=${parity.ok ? "ok" : "BROKEN"} loop-pid=${pid ?? "none"} pending=${flow.pending} live=${flow.live} stalled=${flow.stalled}`,
	);
	process.exit(0);
}
process.exitCode = await run();
