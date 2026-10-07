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
//   3. dispatch flow — a DISPATCHED line in .fleet/loop.log within the last
//     30 min while READY > 0 means the pipeline moved; silence + READY > 0
//     = stalled → kickstart + broadcast.
//   4. governed-path probe — mint a throwaway lane key and push one tiny
//     inference through the :4101 front; the end-to-end proof lanes depend on.
//
// Every verdict lands in .fleet/dispatch-watchdog.log; repairs + probe
// failures broadcast on the coord bus so the fleet sees the outage.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "";
const REPO =
	process.env.SUSPENDERS_WATCHDOG_REPO ?? "/Volumes/Sensitive/github/klh/fleet";
const PREFIX =
	process.env.SUSPENDERS_PREFIX ?? `${HOME}/.claude/hooks/suspenders`;
const FLEET = process.env.SUSPENDERS_FLEET_DIR ?? `${REPO}/.fleet`;
const LOOP_LOG = process.env.SUSPENDERS_LOOP_LOG ?? `${FLEET}/loop.log`;
const SID = process.env.SUSPENDERS_WATCHDOG_SID ?? "watchdog";

const statePath = join(FLEET, "dispatch-watchdog.json");
const logPath = join(FLEET, "dispatch-watchdog.log");

const log = (msg: string): void => {
	appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
};

const sh = (cmd: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
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
			else if (
				readFileSync(p).byteLength !== readFileSync(join(srcDir, f)).byteLength
			)
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
const lastDispatchAgeMin = (): number | null => {
	if (!existsSync(LOOP_LOG)) return null;
	const lines = readFileSync(LOOP_LOG, "utf8")
		.split("\n")
		.filter((l) => l.includes("DISPATCHED"));
	if (lines.length === 0) return null;
	const last = lines[lines.length - 1];
	const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(last);
	if (!m) return null;
	return (Date.now() - Date.parse(m[1])) / 60_000;
};

const readyCount = (): number =>
	sh([process.execPath, `${PREFIX}/bin/work.ts`, "ready"])
		.out.split("\n")
		.filter((l) => l.trim().startsWith("·")).length;

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
		const t0 = Date.now();
		const r = await fetch(
			"http://127.0.0.1:4101/w/watchdog-probe/v1/messages",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${mb.key}`,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: "glm-5.3-flash",
					max_tokens: 16,
					messages: [{ role: "user", content: "ping" }],
				}),
			},
		);
		const ms = Date.now() - t0;
		if (r.status !== 200) {
			const b = (await r.json().catch(() => ({}))) as { detail?: string };
			return {
				ok: false,
				detail: `front ${r.status}: ${(b.detail ?? "").slice(0, 120)}`,
			};
		}
		return { ok: true, detail: `200 in ${ms}ms` };
	} finally {
		await fetch(`http://127.0.0.1:4101/v1/admin/keys/${mb.key_id}/revoke`, {
			method: "POST",
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

const readState = (): { loopPid: number | null } => {
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
		sh(["/bin/bash", join(REPO, "packages/suspenders/install.sh"), "--no-llm"]);
		repaired = true;
		verdicts.push(
			`lib-parity REPAIRED via installer (was: ${parity.missing.length} missing/stale)`,
		);
		emit(
			"BROADCAST",
			`dispatch-watchdog repaired prefix-lib parity (${parity.missing.length} files) via install.sh — fleet-loop was crash-looping; lanes dispatch normally again`,
		);
	} else verdicts.push("lib-parity ok");

	// 2. loop liveness (pid stability across runs)
	const pid = loopPid();
	const prev = readState().loopPid;
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
	// After OUR OWN kickstart the next run MUST adopt fresh: writing the old
	// pid made every subsequent run see churn and kickstart again forever
	// (restart churn caused BY the watchdog — external finding, verified).
	writeFileSync2(
		statePath,
		JSON.stringify({
			loopPid: kicked ? null : pid,
			at: new Date().toISOString(),
		}),
	);

	// 3. dispatch flow
	const age = lastDispatchAgeMin();
	const ready = readyCount();
	if (age === null && ready > 0)
		verdicts.push(`dispatch flow: never dispatched, ${ready} ready — watching`);
	else if (age !== null && age > 30 && ready > 0) {
		verdicts.push(
			`dispatch STALLED: last DISPATCHED ${age.toFixed(0)}min ago, ${ready} ready → kickstart loop`,
		);
		sh([
			"launchctl",
			"kickstart",
			"-k",
			`gui/${process.getuid()}/com.suspenders.fleet-loop`,
		]);
		repaired = true;
		emit(
			"BROADCAST",
			`dispatch-watchdog: no dispatch for ${age.toFixed(0)}min with ${ready} READY — kicked fleet-loop; if it recurs the loop itself needs eyes`,
		);
	} else
		verdicts.push(
			`dispatch flow ok (last ${age === null ? "never" : `${age.toFixed(0)}min ago`}, ready=${ready})`,
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
	const age = lastDispatchAgeMin();
	const ready = readyCount();
	console.log(
		`dry: lib-parity=${parity.ok ? "ok" : `BROKEN(${parity.missing.length})`} loop-pid=${pid ?? "none"} last-dispatch=${age === null ? "never" : `${age.toFixed(0)}min`} ready=${ready}`,
	);
	process.exit(0);
}
process.exitCode = await run();
