// fleet-loop/runtime-sync.ts — W821: the post-merge runtime sync as a
// fail-isolated cycle step. Merges move the pinned checkout's main; the
// serving surfaces only serve merged code after the installed prefix is
// synced (syncHarness) and the touched labels are kickstarted — 2026-10-19:
// W812/W813/W819 landed+merged but no tick ever synced, and the owner saw
// neither borders nor new.prefer semantics while the watchdog showed
// all-services drift. The sweep fires when the sync stamp trails the main
// head (so loop downtime during merges still catches up on the next tick),
// spawns scripts/post-merge-sync.ts as a child (a slow sync never hangs the
// cycle), and a failed sync never advances the stamp — the next cycle
// retries. SUSPENDERS_MAINTENANCE=0 disables (ops escape hatch, one env for
// the whole heartbeat family).
import { homedir } from "node:os";
import { join } from "node:path";
import { readStamp } from "../../../scripts/lib/auto-install.ts";
import { suspendersRoot } from "./maintenance.ts";
import type { LoopDeps } from "./runtime.ts";

export interface RuntimeSyncResult {
	ran: boolean;
	labels: string[];
	reason?: string;
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

export function createRuntimeSync(
	deps: LoopDeps & { MAIN: string },
	overrides?: {
		statePath?: string;
		spawn?: SpawnFn;
	},
): { runtimeSync: () => RuntimeSyncResult } {
	const { REPO, MAIN, log, sh } = deps;
	const spawn = overrides?.spawn ?? defaultSpawn;
	const statePath =
		overrides?.statePath ??
		`${homedir()}/.local/state/suspenders/post-merge-sync.json`;
	const root = suspendersRoot();
	const runner = join(root, "scripts/post-merge-sync.ts");
	const runtimeSync = (): RuntimeSyncResult => {
		if (process.env.SUSPENDERS_MAINTENANCE === "0")
			return { ran: false, labels: [], reason: "disabled" };
		const stamp = readStamp(statePath);
		const head = sh(["git", "rev-parse", MAIN]) || null;
		if (head === null) return { ran: false, labels: [], reason: "git-failed" };
		if (stamp?.main === head) return { ran: false, labels: [] }; // up to date
		// drift (or first run): the child re-derives the same decision and
		// owns the stamp; a killed child leaves it unadvanced → retry next cycle
		const r = spawn(
			[process.execPath, runner, "--repo", join(REPO, "packages/suspenders")],
			{ cwd: REPO, timeoutMs: 240_000 },
		);
		if (r.code === 0) {
			log(`RUNTIME-SYNC ok (main ${head.slice(0, 12)})`);
			return { ran: true, labels: [] };
		}
		log(`RUNTIME-SYNC fail(${r.code}) ${r.out}`);
		return { ran: false, labels: [], reason: `fail(${r.code}) ${r.out}` };
	};
	return { runtimeSync };
}
