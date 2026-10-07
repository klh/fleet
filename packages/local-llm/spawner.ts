// spawner.ts — on-demand specialist lifecycle, shared by swarm.ts (boot) and
// router-shim.ts (demand-driven spawn of tier:"ondemand" specialists like
// :8906). Args derive from registry.ts — the single source of truth — so a
// registry edit changes both boot and on-demand spawn behavior.
//
// ensureUp(s) returns immediately when the port already answers; otherwise it
// spawns the specialist (argument-array Bun.spawn, no shell), polls readiness
// and surfaces the log tail on early exit. Concurrent callers share one
// in-flight load per port (single-flight map).
//
// W500 memory governance (the 2026-10-06/07 OOM crashes): the old flow timed
// out at a fixed 90s while a 22GB model was still loading, left the orphan
// running, and let the next request spawn a SECOND instance — three stacked
// half-loaded copies wired ~63GB and jetsam killed the machine. Guards here:
//   1. spawn ledger (survives router restarts) — a live recent pid means
//      "still loading", the caller WAITS instead of re-spawning;
//   2. load timeout scales with ram_gb (22GB gets ~7min, not 90s);
//   3. wired-RAM budget gate — past the guard band a cold load is refused
//      and the router's ladder falls through to the next route.

import { openSync, readFileSync, writeFileSync } from "node:fs";
import type { Specialist } from "./registry.ts";
import { modelBudgetGb, rapidMemoryArgs } from "./memory-policy.ts";

const HOME = process.env.HOME;
const MLX_PYTHON = `${HOME}/.local/share/uv/tools/mlx-lm/bin/python`;
// rapid-mlx 0.15.0 via uv tool env — absolute path so launchd never needs PATH
// (brew formula still on 0.14.3; benched 2026-09-23: 115.9 vs 107.4 tok/s
// under load, flat vs quiet-machine — adopted for flags/aliases, not speed).
const RAPID = `${HOME}/.local/share/uv/tools/rapid-mlx/bin/rapid-mlx`;
const LOG_DIR = process.env.LOCAL_LLM_LOG_DIR ?? `${HOME}/.claude-insights`;

export const mlxLogPath = (port: number): string =>
	`${LOG_DIR}/mlx-${port}.log`;

// Full argv for one specialist server (binary first) — consumed by both the
// direct Bun.spawn here and swarm.ts's nohup boot path.
export function spawnArgs(s: Specialist): string[] {
	if (s.engine === "rapid") {
		return [
			RAPID,
			"serve",
			s.model,
			"--host",
			"127.0.0.1",
			"--port",
			String(s.port),
			...(s.flags ?? []),
			...rapidMemoryArgs(s.ram_gb),
		];
	}
	return [
		MLX_PYTHON,
		"-m",
		"mlx_lm.server",
		"--port",
		String(s.port),
		"--model",
		s.model,
		"--prompt-cache-size",
		"10",
		"--prompt-cache-bytes",
		"4GB",
		...(s.flags ?? []),
	];
}

export const isUp = async (port: number): Promise<boolean> => {
	try {
		// Any HTTP response = listening. The router (:4000) answers 404 on
		// /v1/models by design — it only implements Anthropic /v1/messages.
		await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
		});
		return true;
	} catch {
		return false;
	}
};

export interface EnsureResult {
	up: boolean;
	cold: boolean; // true when this call did the spawning
	waitedMs: number;
	error?: string; // log tail when the spawned process died loading
}

// 5.6GB 9B loads in seconds; big models get ram_gb × 20s (22GB → ~7min).
const COLD_TIMEOUT_FLOOR_MS = 90_000;
export const coldTimeoutMs = (s: Specialist): number =>
	Math.max(COLD_TIMEOUT_FLOOR_MS, s.ram_gb * 20_000);

// ─── W500: spawn ledger (dedup ACROSS router restarts) ───
// The in-memory single-flight map dies with the process; the ledger is how a
// fresh router recognizes a still-loading specialist instead of stacking a
// second instance. Rows: port → {pid, startedAt}.
const LEDGER_PATH = `${HOME}/.claude/local-llm/.spawn-ledger.json`;
type LedgerRow = { pid: number; startedAt: number };

const readLedger = (): Record<string, LedgerRow> => {
	try {
		return JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Record<
			string,
			LedgerRow
		>;
	} catch {
		return {};
	}
};

const writeLedger = (rows: Record<string, LedgerRow>): void => {
	try {
		writeFileSync(LEDGER_PATH, JSON.stringify(rows));
	} catch {}
};

export const clearLedgerPort = (port: number): void => {
	const rows = readLedger();
	if (rows[String(port)] === undefined) return;
	delete rows[String(port)];
	writeLedger(rows);
};

const pidAlive = (pid: number): boolean =>
	Bun.spawnSync(["/bin/kill", "-0", String(pid)]).exitCode === 0;

// ─── W500: wired-RAM budget gate ───
// vm_stat wired pages × 16KB (arm64 page size). A cold load of a 22GB model
// on a wired-heavy machine is the OOM mechanism itself — refuse it and the
// ladder falls through to the next route.
export const WIRED_GUARD_GB = 60;
export const wiredGb = (): number => {
	const out = Bun.spawnSync(["/usr/bin/vm_stat"]).stdout.toString();
	const m = /Pages wired down:\s+(\d+)/.exec(out);
	return m ? (Number(m[1]) * 16384) / 2 ** 30 : Number.POSITIVE_INFINITY;
};

async function spawnAndWait(s: Specialist): Promise<EnsureResult> {
	const t0 = Date.now();
	const log = mlxLogPath(s.port);
	const fd = openSync(log, "a");
	const child = Bun.spawn(spawnArgs(s), {
		stdin: "ignore",
		stdout: fd,
		stderr: fd,
	});
	const rows = readLedger();
	rows[String(s.port)] = { pid: child.pid, startedAt: t0 };
	writeLedger(rows);
	const cap = coldTimeoutMs(s);
	while (Date.now() - t0 < cap) {
		if (child.exitCode !== null || child.signalCode !== null) {
			clearLedgerPort(s.port);
			let tail = "";
			try {
				tail = readFileSync(log, "utf8").slice(-400);
			} catch {}
			return {
				up: false,
				cold: true,
				waitedMs: Date.now() - t0,
				error: `spawn exited (code=${child.exitCode ?? child.signalCode}): ${tail}`,
			};
		}
		if (await isUp(s.port)) {
			return { up: true, cold: true, waitedMs: Date.now() - t0 };
		}
		await Bun.sleep(500);
	}
	// Timeout with the child still alive is NOT a failure to clean up: the
	// load continues in the background and the ledger keeps later callers
	// from stacking a duplicate. The route falls through for THIS request.
	return {
		up: false,
		cold: true,
		waitedMs: Date.now() - t0,
		error: `no readiness within ${cap / 1000}s — pid ${child.pid} still loading in background (ledgered, no re-spawn)`,
	};
}

// Ready-or-reason. Single-flight per port: concurrent cold requests share the
// load wait instead of double-spawning — and the ledger extends that dedup
// across router restarts.
export function ensureUp(s: Specialist): Promise<EnsureResult> {
	const inflight = pending.get(s.port);
	if (inflight) return inflight;
	const job = (async (): Promise<EnsureResult> => {
		if (await isUp(s.port)) {
			clearLedgerPort(s.port); // listening — no orphan tracking needed
			return { up: true, cold: false, waitedMs: 0 };
		}
		// A recent spawn may still be loading — wait on it, never stack.
		const row = readLedger()[String(s.port)];
		if (row && pidAlive(row.pid)) {
			const cap = coldTimeoutMs(s);
			if (Date.now() - row.startedAt > cap + 60_000) {
				return {
					up: false,
					cold: false,
					waitedMs: 0,
					error: `live loading pid ${row.pid} exceeded deadline; refusing duplicate spawn`,
				};
			} else {
				const t0 = Date.now();
				while (Date.now() - t0 < cap) {
					if (await isUp(s.port))
						return { up: true, cold: false, waitedMs: Date.now() - t0 };
					if (!pidAlive(row.pid)) break; // orphan died — spawn fresh below
					await Bun.sleep(1000);
				}
				return {
					up: false,
					cold: false,
					waitedMs: Date.now() - t0,
					error: `loading (pid ${row.pid}, ${((Date.now() - row.startedAt) / 1000).toFixed(0)}s in) — waited, not stacking a second instance`,
				};
			}
		}
		// Budget gate after the dedup paths: only a genuinely fresh load pays.
		const wired = wiredGb();
		if (wired + modelBudgetGb(s.ram_gb) > WIRED_GUARD_GB) {
			return {
				up: false,
				cold: false,
				waitedMs: 0,
				error: `memory budget: wired ${wired.toFixed(0)}GB > ${WIRED_GUARD_GB}GB guard — refusing cold load of ${s.label}`,
			};
		}
		return spawnAndWait(s);
	})();
	pending.set(s.port, job);
	job.finally(() => pending.delete(s.port)).catch(() => {});
	return job;
}
