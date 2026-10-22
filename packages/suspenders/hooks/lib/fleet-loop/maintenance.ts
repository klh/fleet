// fleet-loop/maintenance.ts — W779: ONE scheduled heartbeat. The no-port
// launchd maintenance agents (monitor, db-backup, harvest, quota-sweep,
// dispatch-watchdog, llm-keepwarm, coord-worker, auto-install, soak) fold
// into this typed task registry, run by the ONE fleet-loop cycle: each cycle
// fires every DUE task — the heartbeat owns the tick, the task owns its own
// cadence and fan-out (callee decides what a fire actually does). Server
// residents (ports/KeepAlive) stay launchd units; they are never listed
// here. Duplicates of today's StartInterval/StartCalendarInterval units are
// impossible by construction: the retired labels ride the services.yaml
// legacyLabels boot-out list, so install --with-launchd unloads them.
//
// Semantics kept from the launchd era:
//   everySeconds ≥ cadence spacing (fire when now-last ≥ every, launchd
//   StartInterval only ever fired ≥ interval too); calendar = first fire
//   at/after the local HH:MM instant, catching up once if the machine slept
//   through it (launchd StartCalendarInterval coalesced misses the same
//   way). Stamps are ATTEMPT-stamped at fire time: a cycle killed by the
//   watchdog never re-fires the same task, and a failing task retries at
//   its next cadence, never hot. SUSPENDERS_MAINTENANCE=0 disables the
//   sweep (ops escape hatch); SUSPENDERS_MAINTENANCE_STAMPS relocates the
//   stamp file (tests).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendSweepNotice, pausePath, readPause } from "./sweep-state.ts";
import type { LoopDeps } from "./runtime.ts";

export interface MaintenanceTask {
	/** registry name — also the stamp key and the log tag */
	name: string;
	/** minimum spacing between fires, seconds (heartbeat ticks ~120s) */
	everySeconds?: number;
	/** daily local fire instant {hour, minute} — first tick at/after it */
	calendar?: { hour: number; minute: number };
	/** darwin/linux nice(1) prefix for heavy children (unit parity) */
	nice?: number;
	/** hard child timeout — the cycle watchdog stays the outer bound */
	timeoutMs: number;
	/** child argv after the bun binary; root = the suspenders package root
	 *  (hooks/bin + scripts runners, identical repo and installed-generation
	 *  layout), repo = the repo the heartbeat serves */
	argv: (root: string, repo: string) => string[];
	/** child cwd; undefined inherits the loop's (REPO) */
	cwd?: (repo: string) => string;
}

export const MAINTENANCE_TASKS: MaintenanceTask[] = [
	{
		name: "fleet-monitor",
		everySeconds: 900,
		timeoutMs: 240_000,
		argv: (root) => [join(root, "hooks/bin/monitor.ts"), "--fix"],
	},
	{
		name: "db-backup",
		calendar: { hour: 10, minute: 0 },
		timeoutMs: 240_000,
		argv: (root) => [join(root, "hooks/bin/db-backup.ts")],
	},
	{
		name: "harvest",
		everySeconds: 900,
		timeoutMs: 240_000,
		argv: (root, repo) => [
			join(root, "hooks/bin/harvest.ts"),
			"run",
			"--repo",
			repo,
		],
	},
	{
		name: "quota-sweep",
		everySeconds: 900,
		timeoutMs: 120_000,
		argv: (root) => [join(root, "hooks/bin/quota-sweep.ts"), "--act"],
	},
	{
		// W804/W782.1: the parked Copilot-quota triplet — W738 opus-5-5
		// re-review, W695.6.2 tool_use proof, W731 copilot digest — FAILED has
		// no reclaim path, so the heartbeat requeues them at the monthly seat
		// reset (~2026-11-01). Self-retiring per item: once all three leave
		// FAILED the runner is a permanent no-op until the entry is retired.
		name: "quota-lift-retry",
		calendar: { hour: 9, minute: 0 },
		timeoutMs: 60_000,
		argv: (root) => [
			join(root, "hooks/bin/quota-lift-retry.ts"),
			"--item",
			"W738,W695.6.2,W731",
			"--after",
			"2026-11-01",
		],
	},
	{
		name: "dispatch-watchdog",
		everySeconds: 300,
		timeoutMs: 300_000,
		argv: (root) => [join(root, "scripts/dispatch-watchdog.ts")],
	},
	{
		name: "llm-keepwarm",
		everySeconds: 240,
		nice: 10,
		timeoutMs: 120_000,
		argv: (root) => [join(root, "hooks/bin/llm-keepwarm.ts")],
	},
	{
		name: "coord-worker",
		everySeconds: 900,
		nice: 10,
		timeoutMs: 600_000,
		argv: (root, repo) => [
			join(root, "scripts/coord-worker.ts"),
			"--repo",
			repo,
		],
		cwd: (repo) => repo,
	},
	{
		name: "auto-install",
		everySeconds: 300,
		timeoutMs: 300_000,
		argv: (root, repo) => [
			join(root, "scripts/auto-install.ts"),
			"--repo",
			repo,
		],
		cwd: (repo) => repo,
	},
	{
		name: "soak",
		calendar: { hour: 3, minute: 15 },
		nice: 10,
		timeoutMs: 1_200_000,
		argv: (root) => [join(root, "hooks/bin/soak.ts")],
	},
	{
		// W826: weekly cache-efficiency mining — ranks the worst cache
		// offenders over the buckle ledger, writes the pulse's mining
		// artifact, lands finding.usage-mining. Advisory: the runner itself
		// fail-softs on any ledger problem.
		name: "usage-mining",
		everySeconds: 604_800,
		timeoutMs: 120_000,
		argv: (root) => [join(root, "hooks/bin/usage-mining.ts")],
	},
	{
		// W827: the rogue-serve reaper — kills lane-leaked serve processes
		// (buckle server, fleet-board, ...) whose cwd sits in a stale
		// .worktrees dir no live lane claim covers (2026-10-19 incident: 100+
		// bun serves from merged/reaped lanes), and prunes merged-and-clean
		// stale worktrees. The CLI defaults to dry-run; the loop fire acts.
		// `.fleet/rogue-reap-paused` pauses.
		name: "rogue-reap",
		everySeconds: 1800,
		nice: 10,
		timeoutMs: 120_000,
		argv: (root, repo) => [
			join(root, "hooks/bin/rogue-reap.ts"),
			"--act",
			"--repo",
			repo,
		],
		cwd: (repo) => repo,
	},
	{
		// W828: the Fleet personal-use license perimeter — walks the repo's
		// node_modules license fields against the permissive allowlist,
		// verifies vendored-bundle banners, records swarm model licenses,
		// and writes the report json the W822 pulse reads. Daily fire;
		// exit 1 on unaccepted violations (a human should notice).
		name: "license-audit",
		calendar: { hour: 5, minute: 45 },
		timeoutMs: 240_000,
		argv: (root, repo) => [
			join(root, "hooks/bin/license-audit.ts"),
			"--repo",
			repo,
		],
		cwd: (repo) => repo,
	},
	{
		// W782.2.1: W452's metrics alerter folded onto the heartbeat — scrapes
		// the fleet's existing /status + /metrics (board :7799, buckle spoke
		// :4101; METRICS_ALERT_TARGETS overrides) every 5 min, alerting drops,
		// failures and queue age. Exit 1 when alerts fired = a fail log here.
		name: "metrics-alert",
		everySeconds: 300,
		timeoutMs: 120_000,
		argv: (root) => [join(root, "hooks/bin/metrics-alert.ts")],
	},
	{
		// W944: the enterprise knowledge sync — decant headless (sync →
		// stats/ls --json, never the db, never transcript surfaces) + the
		// lesson./finding. fact feed, policy-gated (config-over-code,
		// ~/.config/klh/knowledge-sync.json 0600; no file = disabled),
		// pushed to every configured hub board /api/knowledge-ingest with the
		// x-klh-write-token. Facts land hub-side as candidate rows (the W142
		// promote gate governs activation); metrics as idempotent rollups.
		name: "knowledge-sync",
		everySeconds: 1800,
		nice: 10,
		timeoutMs: 120_000,
		argv: (root) => [join(root, "hooks/bin/knowledge-sync.ts")],
	},
	{
		// Machine-local inference key + opted-in hub gate the catalog fetch.
		// A changed route set regenerates LiteLLM and reloads Buckle; failures
		// retain the previous applied marker for the next cadence.
		name: "openrouter-free-refresh",
		everySeconds: 1800,
		timeoutMs: 240_000,
		argv: (root) => [
			join(root, "deploy/openrouter-free-sync.ts"),
			"refresh-configured",
		],
	},
	{
		// W1013: the WS-native ChatGPT auto-coordinate loop — scans the work
		// graph for gated triggers (NEED_DECISION, item failed after >=2 runs,
		// benchmarks.md row) and asks the ChatGPT co-supervisor over the W931
		// board ingress (POST /api/consult; NEVER the clipboard). Answers drain
		// back to the originating item (W861) and close with consult-reply
		// feedback. Machine-level config IS the opt-in (no
		// ~/.config/klh/chatgpt-coordinate.yaml = idle); SUSPENDERS_CHATGPT_COORD=0
		// or `.fleet/chatgpt-auto-paused` kills it for ops.
		name: "chatgpt-coordinate",
		everySeconds: 600,
		nice: 10,
		timeoutMs: 120_000,
		argv: (root, repo) => [
			join(root, "hooks/bin/chatgpt-coordinate.ts"),
			"--repo",
			repo,
		],
		cwd: (repo) => repo,
	},
	{
		// W969 Signals-lite — per-run silent-failure scan of closed lanes
		// through the pinned oracle leg (:8903 default): bounded evidence
		// (transcript tail + capsule + done payload), fixed four-class prompt,
		// verdict → lane.signal events + the blam intake queue. Leg down =
		// hold + retry next fire, silently; never blocks lane close.
		// SUSPENDERS_SIGNALS_SCAN=0 disables the runner.
		name: "signals-scan",
		everySeconds: 600,
		nice: 10,
		timeoutMs: 240_000,
		argv: (root, repo) => [
			join(root, "hooks/bin/signals-scan.ts"),
			"--repo",
			repo,
		],
		cwd: (repo) => repo,
	},
];

// the suspenders package root, identical in the repo worktree
// (packages/suspenders) and the installed generation
// (.harness/packages/suspenders) — hooks/lib/fleet-loop is 3 deep.
export function suspendersRoot(): string {
	return resolve(import.meta.dir, "../../..");
}

export function maintenanceStampsPath(): string {
	const override = process.env.SUSPENDERS_MAINTENANCE_STAMPS;
	if (override !== undefined && override.trim() !== "") return override;
	return join(homedir(), ".claude-insights", "maintenance-stamps.json");
}

export function readStamps(path: string): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return {};
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(parsed))
			if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

export function writeStamps(
	path: string,
	stamps: Record<string, number>,
): void {
	try {
		writeFileSync(path, `${JSON.stringify(stamps, null, "\t")}\n`);
	} catch {}
}

/** interval: due when now-last ≥ everySeconds (never-ran is due);
 *  calendar: due when now ≥ today's local fire instant and the last fire
 *  was strictly before it (the catch-up-once rule). */
export function isDue(
	task: MaintenanceTask,
	lastMs: number | undefined,
	nowMs: number,
): boolean {
	if (task.everySeconds !== undefined) {
		if (lastMs === undefined) return true;
		return nowMs - lastMs >= task.everySeconds * 1000;
	}
	if (task.calendar !== undefined) {
		const now = new Date(nowMs);
		const fire = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			task.calendar.hour,
			task.calendar.minute,
			0,
			0,
		);
		return (
			nowMs >= fire.getTime() &&
			(lastMs === undefined || lastMs < fire.getTime())
		);
	}
	// a task with neither cadence field is malformed — never fire it
	return false;
}

export interface SweepResult {
	ran: string[];
	failed: string[];
	skipped: number;
	/** W1201: one line per failed source — also surfaced via the W822 pulse
	 *  maintenance section (sweep-state readSweepNotices). */
	notices: string[];
}

type SpawnFn = (
	cmd: string[],
	opts: { cwd?: string; timeoutMs: number },
) => { code: number; out: string };

const defaultSpawn: SpawnFn = (cmd, opts) => {
	const p = Bun.spawnSync(cmd, {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: opts.timeoutMs,
	});
	const out =
		`${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`
			.trim()
			.split("\n")
			.filter(Boolean)
			.slice(-3)
			.join(" | ");
	return { code: p.exitCode ?? 1, out };
};

export function createMaintenanceSweep(
	deps: LoopDeps,
	overrides?: {
		tasks?: MaintenanceTask[];
		stampsPath?: string;
		spawn?: SpawnFn;
		now?: () => number;
	},
): { maintenanceSweep: () => SweepResult } {
	const tasks = overrides?.tasks ?? MAINTENANCE_TASKS;
	const stampsPath = overrides?.stampsPath ?? maintenanceStampsPath();
	const spawn = overrides?.spawn ?? defaultSpawn;
	const now = overrides?.now ?? (() => Date.now());
	const root = suspendersRoot();
	const sweep = (): SweepResult => {
		if (process.env.SUSPENDERS_MAINTENANCE === "0")
			return { ran: [], failed: [], skipped: tasks.length, notices: [] };
		const stamps = readStamps(stampsPath);
		const nowMs = now();
		const result: SweepResult = {
			ran: [],
			failed: [],
			skipped: 0,
			notices: [],
		};
		for (const task of tasks) {
			// W1201 budget pause: a named stop-reason marker parks the task —
			// skip + say why, never crash and never a quiet skip.
			const paused = readPause(task.name);
			if (paused !== null) {
				deps.log(
					`MAINT ${task.name} paused(${paused.reason}) — clear ${pausePath(task.name)} to resume`,
				);
				result.skipped++;
				continue;
			}
			if (!isDue(task, stamps[task.name], nowMs)) {
				result.skipped++;
				continue;
			}
			// attempt-stamp BEFORE the child runs: a watchdog-killed cycle
			// never re-fires the same task within its cadence
			stamps[task.name] = nowMs;
			writeStamps(stampsPath, stamps);
			const bun = process.execPath;
			const argv = task.argv(root, deps.REPO);
			const cmd =
				task.nice !== undefined
					? ["/usr/bin/nice", "-n", String(task.nice), bun, ...argv]
					: [bun, ...argv];
			const cwd = task.cwd?.(deps.REPO);
			try {
				const r = spawn(cmd, { cwd, timeoutMs: task.timeoutMs });
				if (r.code === 0) {
					deps.log(`MAINT ${task.name} ok${r.out !== "" ? ` ${r.out}` : ""}`);
					result.ran.push(task.name);
				} else {
					const notice = appendSweepNotice(
						task.name,
						`fail(${r.code})${r.out !== "" ? ` ${r.out}` : ""}`,
					);
					result.notices.push(notice);
					deps.log(
						`MAINT ${task.name} fail(${r.code})${r.out !== "" ? ` ${r.out}` : ""}`,
					);
					result.failed.push(task.name);
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				result.notices.push(appendSweepNotice(task.name, `fail(spawn) ${msg}`));
				deps.log(`MAINT ${task.name} fail(spawn) ${msg}`);
				result.failed.push(task.name);
			}
		}
		return result;
	};
	return { maintenanceSweep: sweep };
}

// task-runner existence check — a folded runner must resolve at the root,
// else the fold silently degraded to a no-op heartbeat; used by the
// registry guard test, not the sweep itself (the sweep fail-logs instead).
export function missingRunners(
	tasks: MaintenanceTask[] = MAINTENANCE_TASKS,
): string[] {
	const root = suspendersRoot();
	return tasks
		.map((t) => t.argv(root, "/"))
		.filter((argv) => !existsSync(argv[0]))
		.map((argv) => argv[0]);
}
