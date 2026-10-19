#!/usr/bin/env bun
// scripts/capacity-bench.ts — W842 laptop-capacity benchmark: run one service
// repo's deterministic test slice across 1/2/4 local worktree lanes, record
// CPU/RAM/disk during the run, and report per-lane completion walls with p95.
//
//   bun scripts/capacity-bench.ts --lanes 1,2,4 [--repo <dir>] [--iters 1]
//       [--task "bun test packages/buckle/test/decide.test.ts ..."] [--tag <s>]
//
// Worktrees are created detached at HEAD under <repo>/.fleet/capacity-bench/
// (untracked), bun-installed, then the task runs concurrently per lane.
// NDJSON records land in <out>/<tag>.ndjson (streams law); the summary table
// prints to stdout. Exit 0 = all lanes exited 0 in every config.
import { mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineVerb, parseVerb } from "../hooks/lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "run",
	usage:
		'usage: capacity-bench --lanes <n[,n...]> [--repo <dir>] [--iters <n>] [--task "<argv>"] [--tag <s>] [--out <dir>] [--keep] --json',
	flags: ["--lanes", "--repo", "--iters", "--task", "--tag", "--out"],
	switches: ["--keep", "--json"],
});

export const p95 = (walls: number[]): number | null => {
	if (walls.length === 0) return null;
	const s = [...walls].sort((a, b) => a - b);
	return s[Math.ceil(0.95 * s.length) - 1];
};

/** task argv split; a leading "bun" token is implied (spawn adds it) */
export const splitTask = (task: string): string[] => {
	const parts = task.split(" ").filter(Boolean);
	return parts[0] === "bun" ? parts.slice(1) : parts;
};

/** parse macOS `top -l 1 -n 0`: active CPU % and used-mem GB */
export const parseTop = (
	out: string,
): { cpuActive: number | null; memUsedGb: number | null } => {
	const cpu = out.match(
		/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys/,
	);
	if (!cpu) return { cpuActive: null, memUsedGb: null };
	const mem = out.match(/PhysMem:\s*([\d.]+)G used/);
	return {
		cpuActive:
			Math.round(
				(Number(cpu[1]) + Number(cpu[2])) * 10,
			) / 10,
		memUsedGb: mem ? Number(mem[1]) : null,
	};
};

/** parse `df -k <path>` → available KiB on the volume holding <path> */
export const parseDf = (out: string): number | null => {
	const lines = out.trim().split("\n");
	const row = lines[lines.length - 1]?.split(/\s+/);
	const avail = row ? Number(row[3]) : NaN;
	return Number.isFinite(avail) ? avail : null;
};

export type LaneRecord = {
	ts: number;
	lanes: number;
	iter: number;
	lane: number;
	install_ms: number | null;
	task_ms: number | null;
	exit: number;
	error?: string;
};

export type ConfigSummary = {
	ts: number;
	lanes: number;
	iters: number;
	wall_ms: number;
	install_p95_ms: number | null;
	task_p95_ms: number | null;
	peak_cpu_active: number | null;
	peak_mem_used_gb: number | null;
	min_disk_avail_kib: number | null;
	all_ok: boolean;
};

const arg = (name: string): string | undefined => {
	const out = parseVerb(SPEC, ["run", ...process.argv.slice(2)]);
	if (!out.ok) throw new Error(out.message);
	return out.parsed.flag(`--${name}`);
};

const hasSwitch = (name: string): boolean => {
	const out = parseVerb(SPEC, ["run", ...process.argv.slice(2)]);
	if (!out.ok) throw new Error(out.message);
	return out.parsed.all(name).length > 0;
};

const REPO = resolve(arg("repo") ?? process.cwd());
const LANE_SET = (arg("lanes") ?? "1,2,4")
	.split(",")
	.map((s) => Number(s.trim()))
	.filter((n) => n > 0);
const ITERS = Number(arg("iters") ?? 1);
const TASK = splitTask(
	arg("task") ?? "bun test packages/buckle/test",
);
const TAG = arg("tag") ?? new Date().toISOString().replace(/[:.]/g, "-");
const OUT = resolve(arg("out") ?? join(REPO, ".fleet", "capacity-bench"));
const KEEP = hasSwitch("keep");
const BUN = process.execPath;

const git = (args: string[], cwd?: string): number => {
	const r = Bun.spawnSync(["git", ...args], {
		cwd: cwd ?? REPO,
		stdout: "pipe",
		stderr: "pipe",
	});
	return r.exitCode ?? 1;
};

const spawnLive = async (
	argv: string[],
	cwd: string,
): Promise<{ code: number; ms: number }> => {
	const t0 = Date.now();
	const child = Bun.spawn(argv, {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});
	await child.exited;
	return { code: child.exitCode ?? 1, ms: Date.now() - t0 };
};

// ---- system sampler (1s cadence while lanes run)
type Sample = {
	cpuActive: number | null;
	memUsedGb: number | null;
	diskAvailKib: number | null;
};

const sampleOnce = async (): Promise<Sample> => {
	const t = Bun.spawnSync(["top", "-l", "1", "-n", "0"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const parsed = parseTop(t.stdout.toString());
	const d = Bun.spawnSync(["df", "-k", REPO], {
		stdout: "pipe",
		stderr: "ignore",
	});
	return {
		...parsed,
		diskAvailKib: parseDf(d.stdout.toString()),
	};
};

const startSampler = (onSample: (s: Sample) => void): () => void => {
	let live = true;
	void (async () => {
		while (live) {
			onSample(await sampleOnce());
			await Bun.sleep(1000);
		}
	})();
	return () => {
		live = false;
	};
};

// ---- per-lane flow: bun install then the task, timed
type LaneOutcome = {
	install: { code: number; ms: number } | null;
	task: { code: number; ms: number } | null;
};

const runLane = async (wt: string): Promise<LaneOutcome> => {
	const install = await spawnLive([BUN, "install"], wt);
	const task = await spawnLive([BUN, ...TASK], wt);
	return { install, task };
};

const runConfig = async (n: number, ndjson: string): Promise<ConfigSummary> => {
	const t0 = Date.now();
	const samples: Sample[] = [];
	const wts: string[] = [];
	for (let i = 0; i < n; i++) {
		const wt = join(OUT, `lanes${n}-i0-${i}`);
		const code = git(["worktree", "add", "--detach", wt, "HEAD"]);
		if (code !== 0)
			throw new Error(`worktree add failed for ${wt}`);
		wts.push(wt);
	}
	const stop = startSampler((s) => samples.push(s));
	const agg = await runIters(wts, ndjson, n);
	stop();
	const peak = (vals: (number | null)[]): number | null => {
		const nums = vals.filter((v): v is number => v !== null);
		return nums.length > 0 ? Math.max(...nums) : null;
	};
	if (!KEEP) cleanupWorktrees(wts);
	return {
		ts: t0,
		lanes: n,
		iters: ITERS,
		wall_ms: Date.now() - t0,
		install_p95_ms: p95(agg.installs),
		task_p95_ms: p95(agg.walls),
		peak_cpu_active: peak(samples.map((s) => s.cpuActive)),
		peak_mem_used_gb: peak(samples.map((s) => s.memUsedGb)),
		min_disk_avail_kib:
			samples.length > 0
				? Math.min(
						...samples
							.map((s) => s.diskAvailKib)
							.filter((v): v is number => v !== null),
					)
				: null,
		all_ok: agg.allOk,
	};
};

const cleanupWorktrees = (wts: string[]): void => {
	for (const wt of wts)
		Bun.spawnSync(["git", "worktree", "remove", "--force", wt], {
			stdout: "ignore",
			stderr: "ignore",
		});
	Bun.spawnSync(["git", "worktree", "prune"], {
		stdout: "ignore",
		stderr: "ignore",
	});
};

const runIters = async (
	wts: string[],
	ndjson: string,
	n: number,
): Promise<{
	walls: number[];
	installs: number[];
	allOk: boolean;
}> => {
	const walls: number[] = [];
	const installs: number[] = [];
	let allOk = true;
	for (let iter = 0; iter < ITERS; iter++) {
		const outcomes = await Promise.all(wts.map((wt) => runLane(wt)));
		outcomes.forEach((o, i) => {
			if (o.install) installs.push(o.install.ms);
			if (o.task) walls.push(o.task.ms);
			if ((o.task?.code ?? 1) !== 0) allOk = false;
			writeRecord(ndjson, {
				ts: Date.now(),
				lanes: n,
				iter,
				lane: i,
				install_ms: o.install?.ms ?? null,
				task_ms: o.task?.ms ?? null,
				exit: o.task?.code ?? 1,
			} satisfies LaneRecord);
		});
	}
	return { walls, installs, allOk };
};

const writeRecord = (path: string, rec: unknown): void => {
	appendFileSync(path, `${JSON.stringify(rec)}\n`);
};

const fmtMs = (v: number | null): string =>
	v === null ? "n/a" : `${(v / 1000).toFixed(1)}s`;

const fmtPct = (v: number | null): string =>
	v === null ? "n/a" : `${v.toFixed(1)}%`;

const fmtGb = (v: number | null): string =>
	v === null ? "n/a" : `${v.toFixed(0)}G`;

const fmtKib = (v: number | null): string =>
	v === null ? "n/a" : `${(v / 1024 / 1024).toFixed(0)}GiB`;

// ---- main: sequential lane-count configs, NDJSON records, cleanup
mkdirSync(OUT, { recursive: true });
const ndjson = join(OUT, `${TAG}.ndjson`);

const printSummary = (s: ConfigSummary): void => {
	console.log(
		`lanes=${s.lanes} wall=${(s.wall_ms / 1000).toFixed(1)}s ` +
			`install_p95=${fmtMs(s.install_p95_ms)} ` +
			`task_p95=${fmtMs(s.task_p95_ms)} ` +
			`peak_cpu=${fmtPct(s.peak_cpu_active)} ` +
			`peak_mem=${fmtGb(s.peak_mem_used_gb)} ` +
			`disk_min=${fmtKib(s.min_disk_avail_kib)} ` +
			`all_ok=${s.all_ok}`,
	);
};

for (const n of LANE_SET) {
	const summary = await runConfig(n, ndjson);
	writeRecord(ndjson, summary);
	printSummary(summary);
}

