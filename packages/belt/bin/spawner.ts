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

import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { serverKvArgs } from "./kv-prefix.ts";
import {
	coldLoadTimeoutMs,
	modelBudgetGb,
	rapidMemoryArgs,
	wiredGuardGb,
} from "./memory-policy.ts";
import type { Platform, PlatformDefinition, Specialist } from "./registry.ts";
import { platformDefinitions, runtimeFor, thisPlatform } from "./registry.ts";
import {
	admitSpawn,
	type SpawnRow,
	withSpawnLedger,
} from "./spawn-admission.ts";

const HOME = process.env.HOME;
const MLX_PYTHON = `${HOME}/.local/share/uv/tools/mlx-lm/bin/python`;
// rapid-mlx 0.15.0 via uv tool env — absolute path so launchd never needs PATH
// (brew formula still on 0.14.3; benched 2026-09-23: 115.9 vs 107.4 tok/s
// under load, flat vs quiet-machine — adopted for flags/aliases, not speed).
const RAPID = `${HOME}/.local/share/uv/tools/rapid-mlx/bin/rapid-mlx`;
const LOG_DIR = process.env.LOCAL_LLM_LOG_DIR ?? `${HOME}/.claude-insights`;

// llama.cpp backend (win32/linux, W765): env override for the binary; PATH
// default — no launchd there, hub installs put llama-server on PATH.
const LLAMA_SERVER = process.env.BELT_LLAMA_SERVER ?? "llama-server";

// accel argv straight from the platformDefinitions table
const ACCEL_ARGS: Record<PlatformDefinition["accel"], string[]> = {
	metal: [], // MLX owns metal acceleration; no extra flags
	vulkan: ["-ngl", "99"], // offload every layer to the GPU
	cpu: [],
};

export const mlxLogPath = (port: number): string =>
	`${LOG_DIR}/mlx-${port}.log`;

// Full argv for one specialist server (binary llama-server first) — consumed by
// both the direct Bun.spawn here and swarm.ts's nohup boot path. The serving
// runtime (platform table or the row's own attr) picks the backend; flags ride
// the chosen engine's dialect.
export function spawnArgs(
	s: Specialist,
	platform: Platform = thisPlatform(),
): string[] {
	if (runtimeFor(s, platform) === "llama.cpp") {
		return [
			LLAMA_SERVER,
			"--host",
			"127.0.0.1",
			"--port",
			String(s.port),
			"--model",
			s.model,
			...ACCEL_ARGS[platformDefinitions[platform].accel],
			...(s.flags ?? []),
			"--jinja",
		];
	}
	if (s.engine === "rapid") {
		return [
			RAPID,
			"serve",
			s.serveModel ?? s.model,
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
		// W240: persistent packet-prefix KV — appended only when the probe
		// file says the installed mlx_lm server declares the flags (no-op on
		// 0.31.3; lights up when upstream ships cache-file ingestion).
		...serverKvArgs(s.model),
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

export interface QuickEnsureResult {
	up: boolean;
	warming: boolean;
	retryAfterMs: number;
	error?: string;
}

const coldRetryAfterMs = (): number => {
	const seconds = Number(process.env.BELT_COLD_RETRY_AFTER_S ?? 30);
	const base = Number.isFinite(seconds) && seconds >= 1 ? seconds : 30;
	// Independent requests spread their next probe across a window, so a
	// 30-40-lane cold fallback cannot synchronize into a refill burst.
	return Math.ceil(base + Math.random() * base) * 1000;
};

/** Request-path admission: never wait for a cold model's multi-minute load.
 * Existing ledger reservations prevent duplicate starts across router restarts.
 * A refused memory reservation is a prompt refusal, never a retrying spawn. */
export async function ensureAvailable(
	s: Specialist,
): Promise<QuickEnsureResult> {
	if (await isUp(s.port)) return { up: true, warming: false, retryAfterMs: 0 };
	const retryAfterMs = coldRetryAfterMs();
	const row = readLedger()[String(s.port)];
	if (row && pidAlive(row.pid)) {
		return {
			up: false,
			warming: true,
			retryAfterMs,
			error: `model :${s.port} is loading (pid ${row.pid})`,
		};
	}
	if (process.env.BELT_DEMAND_WARMUP === "0") {
		return {
			up: false,
			warming: false,
			retryAfterMs,
			error: `model :${s.port} is cold; demand warmup disabled`,
		};
	}
	try {
		const child = spawnReserved(s);
		void child.exited
			.then(() => clearLedgerPort(s.port))
			.catch((error) =>
				console.error(`model :${s.port} spawn ledger cleanup failed: ${error}`),
			);
		return {
			up: false,
			warming: true,
			retryAfterMs,
			error: `model :${s.port} warmup started (pid ${child.pid})`,
		};
	} catch (error) {
		// A concurrent request can win the ledger reservation after our read.
		// Both cases are bounded refusals; the next request re-probes liveness.
		return {
			up: false,
			warming: false,
			retryAfterMs,
			error: String(error),
		};
	}
}

// 5.6GB 9B loads in seconds; big models get ram_gb × 20s (22GB → ~7min).
export const coldTimeoutMs = (s: Specialist): number =>
	coldLoadTimeoutMs(s.ram_gb);

// Single-flight per port — concurrent cold requests share one load wait.
const pending = new Map<number, Promise<EnsureResult>>();

// ─── W500: spawn ledger (dedup ACROSS router restarts) ───
// The in-memory single-flight map dies with the process; the ledger is how a
// fresh router recognizes a still-loading specialist instead of stacking a
// second instance. Rows: port → {pid, startedAt}.
const LEDGER_PATH = `${HOME}/.claude/local-llm/.spawn-ledger.json`;
type LedgerRow = SpawnRow;

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

export const clearLedgerPort = (port: number): void => {
	withSpawnLedger(LEDGER_PATH, (rows) => {
		const row = rows[String(port)];
		if (row && !pidAlive(row.pid)) delete rows[String(port)];
	});
};

const pidAlive = (pid: number): boolean =>
	Bun.spawnSync(["/bin/kill", "-0", String(pid)]).exitCode === 0;

const readyListener = (port: number, pid: number): boolean => {
	if (process.platform !== "darwin") return false;
	const probe = Bun.spawnSync([
		"/usr/sbin/lsof",
		"-nP",
		`-tiTCP:${port}`,
		"-sTCP:LISTEN",
	]);
	return (
		probe.exitCode === 0 &&
		probe.stdout.toString().trim().split("\n").includes(String(pid))
	);
};

// ─── W500: wired-RAM budget gate ───
// Per-OS memory-pressure probe behind ONE interface (W766): macOS keeps
// vm_stat (wired pages × 16KB arm64 page), Linux reads /proc/meminfo
// (MemTotal − MemAvailable, MemFree fallback), Windows takes max(working
// set, commit charge) via Get-CimInstance. A cold load of a 22GB model on
// a wired-heavy machine is the OOM mechanism itself — refuse it and the
// ladder falls through to the next route. Probe failure → Infinity → the
// guard refuses (fail-closed, same as a vm_stat parse miss on macOS).
// clamp: empty env → Number("") = 0 (refuse every load); garbage → NaN
// (comparisons false, guard never trips — fail-open OOM). glm-5.3 review
// of f4aad15c: env knobs validate or fall back to the default.
export const WIRED_GUARD_GB = wiredGuardGb(process.env.BELT_WIRED_GUARD_GB);

// Get-CimInstance one-liner: physical used (working set) vs commit charge,
// the larger wins — both are OOM precursors on Windows.
const CIM_PROBE =
	"$o=Get-CimInstance Win32_OperatingSystem; [math]::Max($o.TotalVisibleMemorySize-$o.FreePhysicalMemory, $o.TotalVirtualMemorySize-$o.FreeVirtualMemory)";

/** /proc/meminfo pressure (MemTotal − MemAvailable, MemFree fallback) → GB. */
export const meminfoUsedGb = (out: string): number => {
	const kb = (key: string): number | undefined => {
		const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(out);
		return m ? Number(m[1]) : undefined;
	};
	const total = kb("MemTotal");
	const avail = kb("MemAvailable") ?? kb("MemFree");
	return total === undefined || avail === undefined
		? Number.POSITIVE_INFINITY
		: (total - avail) / 2 ** 20;
};

/** max(working set, commit charge) in kB (Get-CimInstance output) → GB. */
export const cimUsedGb = (out: string): number => {
	const m = /^\s*(\d+)\s*$/.exec(out);
	return m ? (Number(m[1]) * 1024) / 2 ** 30 : Number.POSITIVE_INFINITY;
};
export const wiredGb = (): number => {
	if (process.platform === "linux") {
		try {
			return meminfoUsedGb(readFileSync("/proc/meminfo", "utf8"));
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	}
	if (process.platform === "win32") {
		try {
			return cimUsedGb(
				Bun.spawnSync([
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					CIM_PROBE,
				]).stdout.toString(),
			);
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	}
	const out = Bun.spawnSync(["/usr/bin/vm_stat"]).stdout.toString();
	const m = /Pages wired down:\s+(\d+)/.exec(out);
	return m ? (Number(m[1]) * 16384) / 2 ** 30 : Number.POSITIVE_INFINITY;
};

/** All resident, boot and demand paths share the same process-wide admission. */
export function spawnReserved(s: Specialist): ReturnType<typeof Bun.spawn> {
	const log = mlxLogPath(s.port);
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(log, "a");
	try {
		return admitSpawn({
			path: LEDGER_PATH,
			port: s.port,
			budgetGb: modelBudgetGb(s.ram_gb),
			guardGb: WIRED_GUARD_GB,
			wiredGb,
			alive: pidAlive,
			ready: readyListener,
			spawn: () =>
				Bun.spawn(spawnArgs(s), { stdin: "ignore", stdout: fd, stderr: fd }),
			cancel: (child) => child.kill(),
		});
	} finally {
		closeSync(fd);
	}
}

async function spawnAndWait(s: Specialist): Promise<EnsureResult> {
	const t0 = Date.now();
	const log = mlxLogPath(s.port);
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = spawnReserved(s);
	} catch (error) {
		return { up: false, cold: false, waitedMs: 0, error: String(error) };
	}
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
