#!/usr/bin/env bun
// dispatch-watchdog.ts — the supervisor's supervisor (2026-10-06 outage class).
// Every 5 minutes (launchd interval), probe the four failure points that
// silently stalled crunching today and report them:
//
//   1. Receipt-backed integrity of the activated generation, never the mutable
//      checkout. Findings cannot invoke installation or service restart.
//   2. fleet-loop liveness — same-pid stability across checks; a churning pid
//      (crash-loop) or no pid at all → report to the deployment owner.
//   3. work flow — project graph completions + process-backed live lanes;
//      dead claimed backlog is pending, dispatch chatter is not progress.
//   4. governed-path probe — mint a throwaway lane key and push one tiny
//     inference through the :4101 front; the end-to-end proof lanes depend on.
//
// Every verdict lands in .fleet/dispatch-watchdog.log; resource actions + probe
// failures broadcast on the coord bus so the fleet sees the outage.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnLedger } from "../../belt/bin/spawn-admission.ts";
import { inspectActivatedDispatch } from "./lib/activated-dispatch.ts";
import { validateBeltWiredGuard } from "./lib/belt-wired-guard.ts";
import {
	deliverWatchdogDecision,
	recoverWatchdogDecision,
} from "./lib/watchdog-decision.ts";
import type { ProgressState, WorkStats } from "./lib/fleet-progress.ts";
import { laneProbeReply } from "./lib/lane-probe-sse.ts";
import { laneToolRoundtrip } from "./lib/lane-tool-probe.ts";
import {
	type ResourceAction,
	resourceAction,
} from "./lib/resource-actuator.ts";
import {
	digestUnit,
	driftNotices,
	inspectServices,
	readActivation,
	type ServiceVerdict,
} from "./lib/service-drift.ts";
import {
	type LaneAudit,
	watchdogLiveness,
	watchdogProgress,
} from "./lib/watchdog-liveness.ts";
import {
	emergencyWiredLimitGb,
	loadingReservation,
} from "./lib/watchdog-memory.ts";
import {
	type WatchdogDimension,
	watchdogVerdict,
} from "./lib/watchdog-verdict.ts";

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
const libParity = (): {
	ok: boolean;
	missing: string[];
	state: "ok" | "degraded" | "unknown";
} => {
	const integrity = inspectActivatedDispatch(PREFIX);
	return {
		ok: integrity.state === "ok",
		missing: integrity.failures,
		state: integrity.state,
	};
};

// Explicit activation receipt, exact-domain inspection; never adopt a manual listener.
const effectiveServices = (): ServiceVerdict[] => {
	try {
		const activated = inspectActivatedDispatch(PREFIX);
		if (activated.state !== "ok" || !activated.root)
			throw new Error("activated service manifest provenance unavailable");
		return inspectServices(
			readActivation(join(HOME, ".config/klh/service-activation.json")),
			`gui/${process.getuid()}`,
			join(activated.root, "packages/suspenders/deploy/services.yaml"),
		);
	} catch {
		return [
			{
				label: "activation-receipt",
				state: "unknown",
				reason:
					"explicit service activation receipt unavailable; installer audit required",
				pid: null,
			},
		];
	}
};
const loopPid = (): number | null =>
	effectiveServices().find(
		(service) =>
			service.label === "com.suspenders.fleet-loop" &&
			service.state === "running",
	)?.pid ?? null;

// ---------- 3. dispatch flow ----------
const progressSnapshot = (): {
	stats: WorkStats;
	live: number;
	unknown: number;
} => {
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
		...watchdogLiveness(REPO, JSON.parse(lanes.out) as LaneAudit[]),
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
			return await laneProbeReply(r);
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
const LITELLM_RSS_GUARD_GB = 4;
const EXEMPT_PORTS = new Set([8902, 8913]);

const activatedWiredLimitGb = (): number | null => {
	try {
		if (
			effectiveServices().find((s) => s.label === "com.suspenders.belt-swarm")
				?.state !== "running"
		)
			return null;
		const receipt = readActivation(
			join(HOME, ".config/klh/service-activation.json"),
		);
		const belt = receipt.services.find(
			(s) => s.label === "com.suspenders.belt-swarm",
		);
		if (!belt || digestUnit(readFileSync(belt.unit)) !== belt.unitSha256)
			return null;
		const guard = validateBeltWiredGuard(
			join(HOME, ".claude/local-llm/belt.env"),
		);
		if (!guard.ok) return null;
		return emergencyWiredLimitGb(guard.value);
	} catch {
		return null;
	}
};

const spawnLedger = (): SpawnLedger | null => {
	try {
		const rows = JSON.parse(
			readFileSync(join(HOME, ".claude/local-llm/.spawn-ledger.json"), "utf8"),
		);
		if (!rows || Array.isArray(rows) || typeof rows !== "object") return null;
		for (const row of Object.values(rows) as Array<{
			pid?: number;
			startedAt?: number;
			ram_gb?: number;
		}>) {
			if (
				!row ||
				!Number.isInteger(row.pid) ||
				!Number.isFinite(row.startedAt) ||
				(row.ram_gb !== undefined &&
					(!Number.isFinite(row.ram_gb) || row.ram_gb < 0))
			)
				return null;
		}
		return rows as SpawnLedger;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
	}
};

const wiredNowGb = (): number => {
	const out = sh(["/usr/bin/vm_stat"]).out;
	const m = /Pages wired down:\s+(\d+)/.exec(out);
	return m ? (Number(m[1]) * 16384) / 2 ** 30 : -1;
};

const portRssGb = (port: number): number | null => {
	const inspection = sh([
		"/usr/sbin/lsof",
		"-ti",
		`tcp:${port}`,
		"-sTCP:LISTEN",
	]);
	if (inspection.code !== 0 && inspection.out.trim()) return null;
	const pid = inspection.out.split("\n")[0];
	if (!pid) return inspection.code === 1 ? 0 : null;
	const kb = Number.parseInt(
		sh(["/bin/ps", "-o", "rss=", "-p", pid]).out.trim(),
		10,
	);
	return Number.isFinite(kb) ? kb / 1048576 : null;
};

const actOnResource = (
	label: string,
	pid: number,
	port: number,
	reason: string,
): ResourceAction =>
	resourceAction(
		join(HOME, ".config/klh/watchdog-actions.sqlite"),
		{ label, pid, port, reason },
		(owner) => effectiveServices().find((service) => service.label === owner),
	);

const reapHeaviestMlx = (): ResourceAction => {
	const ledger = spawnLedger();
	if (!ledger)
		return { state: "held", detail: "spawn reservation ledger unavailable" };
	const out = sh(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]).out;
	const rows: { port: number; pid: number; rss: number }[] = [];
	for (const line of out.split("\n")) {
		const m = /^\S+\s+(\d+)\s+\S+\s+.*127\.0\.0\.1:(890\d|891\d)\s/.exec(line);
		if (!m) continue;
		const port = Number.parseInt(m[2], 10);
		if (EXEMPT_PORTS.has(port)) continue;
		if (loadingReservation(port, Number(m[1] ?? 0), ledger)) continue;
		const rss = portRssGb(port);
		if (rss !== null) rows.push({ port, pid: Number(m[1]), rss });
	}
	if (rows.length === 0)
		return { state: "held", detail: "no reapable MLX listener" };
	rows.sort((a, b) => b.rss - a.rss);
	const h = rows[0];
	if (!h) return { state: "held", detail: "no reapable MLX listener" };
	return actOnResource(
		"com.suspenders.belt-swarm",
		h.pid,
		h.port,
		`wired memory guard; listener RSS ${h.rss.toFixed(1)}GB`,
	);
};

// ---------- repair + report ----------
const emit = (kind: string, note: string): boolean => {
	try {
		const result = sh([
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
		if (result.code === 0) return true;
	} catch {
		// Keep the decision eligible on the next watchdog pass.
	}
	log(`coord delivery failed: ${kind}`);
	return false;
};

const readState = (): ProgressState & {
	loopPid: number | null;
	serviceFingerprints?: Record<string, string>;
	serviceCheckAt?: number;
	decisionEmits?: Record<string, number>;
} => {
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return { loopPid: null };
	}
};

const run = async (): Promise<number> => {
	const verdicts: string[] = [];
	let repaired = false;

	// W797: the watchdog runs every 5 minutes; unconditioned NEED_DECISIONs
	// flooded the owner's feed with the same card for hours (graph-stalled
	// repeated every pass). State-repeat reasons re-emit at most once per 6h;
	// the verdict still lands in the log every pass.
	const previous = readState();
	const DECISION_TTL_MS = 6 * 60 * 60 * 1000;
	const decisionEmits = { ...(previous.decisionEmits ?? {}) };
	const emitDecision = (key: string, note: string): void => {
		deliverWatchdogDecision(
			decisionEmits,
			key,
			note,
			Date.now(),
			DECISION_TTL_MS,
			(message) => emit("NEED_DECISION", message),
		);
	};

	// 1. Immutable activation integrity. Deployment belongs to the installer owner.
	const parity = libParity();
	verdicts.push(`activation integrity ${parity.state}`);
	if (!parity.ok)
		emitDecision(
			"activation-degraded",
			`dispatch activation ${parity.state}: ${parity.missing.join(", ")}; observation only, no installer or restart invoked`,
		);

	// 2. Service drift is read-only. Legitimate PID changes are not restart requests.
	const services = effectiveServices();
	const drift = driftNotices(
		services,
		previous.serviceFingerprints,
		Date.now(),
		previous.serviceCheckAt,
	);
	for (const finding of drift.notices) {
		const healthy =
			finding.state === "running" ||
			finding.state === "scheduled-idle" ||
			finding.state === "starting";
		const note = `service supervision ${finding.label}: ${finding.state} — ${finding.reason}; read-only audit, no restart performed`;
		// W848: NEED_DECISIONs take the W797 6h TTL gate, per-label key —
		// ghost-label/stale-receipt storms re-carded every 5-min pass.
		if (healthy) emit("BROADCAST", note);
		else emitDecision(`drift:${finding.label}`, note);
	}
	verdicts.push(
		...services.map((service) => `service ${service.label} ${service.state}`),
	);
	const pid =
		services.find(
			(service) =>
				service.label === "com.suspenders.fleet-loop" &&
				service.state === "running",
		)?.pid ?? null;
	// 3. Project graph/liveness, never dispatch-log timestamps.
	let nextState: ProgressState = previous;
	let progress: WatchdogDimension = {
		name: "progress",
		state: "unknown",
		detail: "structured graph/liveness unavailable",
	};
	try {
		const snapshot = progressSnapshot();
		const flow = watchdogProgress(
			snapshot.stats,
			snapshot,
			previous,
			Date.now(),
		);
		nextState = flow.state;
		progress = {
			name: "progress",
			state: flow.verdict,
			detail: `pending=${flow.pending}, live=${flow.live}, unknown=${flow.unknown}, done=${flow.state.done}`,
		};
		verdicts.push(
			`work flow ${flow.stalled ? "STALLED" : flow.unknown > 0 ? "UNKNOWN" : flow.pending === 0 ? "idle" : "active/watching"} (pending=${flow.pending}, live=${flow.live}, unknown=${flow.unknown}, done=${flow.state.done})`,
		);
		if (flow.stalled)
			emitDecision(
				"graph-stalled",
				"Fleet graph stalled; inspect dead claims and service activation before an owner-authorized recovery. No automatic restart performed.",
			);
	} catch {
		verdicts.push("work flow UNKNOWN: structured graph/liveness unavailable");
		emitDecision(
			"graph-unavailable",
			"Watchdog cannot verify graph progress; restore structured work stats/liveness.",
		);
	}
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
	const wiredLimit = activatedWiredLimitGb();
	const litellmGb = portRssGb(4100);
	const memory: WatchdogDimension = {
		name: "memory",
		state:
			(wiredLimit !== null && wired > wiredLimit) ||
			(litellmGb !== null && litellmGb > LITELLM_RSS_GUARD_GB)
				? "degraded"
				: wired < 0 || wiredLimit === null || litellmGb === null
					? "unknown"
					: "ok",
		detail: `wired=${wired < 0 ? "unknown" : `${wired.toFixed(1)}GB`}, emergencyLimit=${wiredLimit === null ? "unknown" : `${wiredLimit.toFixed(1)}GB`}, gatewayRSS=${litellmGb === null ? "unknown" : `${litellmGb.toFixed(1)}GB`}; emergency action does not prove recovery`,
	};
	const resourceActions: ResourceAction[] = [];
	if (wired >= 0) {
		if (wiredLimit !== null && wired > wiredLimit) {
			const action = reapHeaviestMlx();
			resourceActions.push(action);
			verdicts.push(
				`memory GUARD: wired ${wired.toFixed(0)}GB > ${wiredLimit.toFixed(0)}GB → ${action.state}: ${action.detail}`,
			);
			const note = `dispatch-watchdog memory guard: wired ${wired.toFixed(0)}GB — ${action.state}: ${action.detail}; receipt=${action.receipt ?? "none"}`;
			if (action.state === "signaled") emit("BROADCAST", note);
			else emitDecision("memory-wired-guard", note);
			repaired ||= action.state === "signaled";
		} else {
			verdicts.push(
				`memory ${wiredLimit === null ? "unknown" : "ok"} (wired ${wired.toFixed(0)}GB)`,
			);
			if (wiredLimit !== null)
				recoverWatchdogDecision(decisionEmits, "memory-wired-guard");
		}
		if (litellmGb !== null && litellmGb > LITELLM_RSS_GUARD_GB) {
			const pid = sh([
				"/usr/sbin/lsof",
				"-ti",
				"tcp:4100",
				"-sTCP:LISTEN",
			]).out.trim();
			const pids = pid.split("\n").filter(Boolean);
			const action: ResourceAction =
				pids.length === 1
					? actOnResource(
							"com.suspenders.cloud-gateway",
							Number(pids[0]),
							4100,
							`gateway RSS ${litellmGb.toFixed(1)}GB exceeds ${LITELLM_RSS_GUARD_GB}GB`,
						)
					: {
							state: "held",
							detail: "UNKNOWN gateway listener ownership; no unique target",
						};
			resourceActions.push(action);
			verdicts.push(
				`litellm RSS ${litellmGb.toFixed(1)}GB > ${LITELLM_RSS_GUARD_GB}GB → ${action.state}: ${action.detail}`,
			);
			const note = `dispatch-watchdog cloud resource action ${action.state}: ${action.detail}; receipt=${action.receipt ?? "none"}`;
			if (action.state === "signaled") emit("BROADCAST", note);
			else emitDecision("memory-cloud-gateway", note);
			repaired ||= action.state === "signaled";
		}
	}
	if (litellmGb !== null && litellmGb <= LITELLM_RSS_GUARD_GB)
		recoverWatchdogDecision(decisionEmits, "memory-cloud-gateway");
	if (!probe.ok) {
		emitDecision(
			"lane-path-failing",
			`dispatch-watchdog: governed lane path FAILING — ${probe.detail}. Lanes will die on first inference; check buckle :4101 + the ladder locals.`,
		);
	}

	const health = watchdogVerdict({
		activation: {
			name: "activation",
			state: parity.state,
			detail:
				parity.missing.join("; ") ||
				"activated payload and dispatch syntax verified",
		},
		services,
		// fleet-loop retired 2026-10-18 (owner GO, #41257 option a): the blind
		// merger/double-dispatcher stays dead; session refill crons + the
		// coordinator own dispatch and merges until W779's typed heartbeat
		// lands. No required service pins a label the receipt no longer
		// renders.
		requiredServices: [],
		progress,
		lane: {
			name: "lane",
			state: probe.ok ? "ok" : "degraded",
			detail: probe.detail,
		},
		memory,
	});
	// Preserve prior action history, but observation alone never increments restart counts.
	writeFileSync2(
		statePath,
		JSON.stringify({
			...nextState,
			loopPid: pid,
			serviceFingerprints: drift.fingerprints,
			serviceCheckAt: drift.notifiedAt,
			decisionEmits,
			at: health.at,
			health,
			resourceActions,
		}),
	);
	verdicts.unshift(`aggregate ${health.state}`);
	log(verdicts.join(" | "));
	if (repaired)
		console.log(`watchdog: resource action sent (${verdicts.join(" | ")})`);
	else console.log(`watchdog: ${verdicts.join(" | ")}`);
	return health.exitCode;
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
	const flow = watchdogProgress(
		snapshot.stats,
		snapshot,
		readState(),
		Date.now(),
	);
	console.log(
		`dry: lib-parity=${parity.ok ? "ok" : "BROKEN"} loop-pid=${pid ?? "none"} pending=${flow.pending} live=${flow.live} unknown=${flow.unknown} stalled=${flow.stalled}`,
	);
	process.exit(0);
}
process.exitCode = await run();
