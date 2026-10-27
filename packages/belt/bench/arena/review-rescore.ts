// review-rescore.ts — W1476 (b): reviewer changes are rescored against the
// whole set (docs/paas-engineering-standard-2026-10-23.md:851). An arm's
// fingerprint hashes the HEAD git blobs of its review-surface.json paths
// plus the shared scoring files, its env pins (REVIEW_LANE_MODEL = the
// review model pin the suspenders runner resolves) and the sealed-set hash,
// so a prompt, model, tooling or set change makes the arm due. A due arm
// reruns over the whole sealed set and appends one row to
// results/review-ledger.jsonl: the score plus its delta against the arm's
// previous scored run (common tasks; new incident cases counted apart).
// Singleflight via results/review-rescore.lock (pid-checked), debounced by
// the surface's minIntervalSeconds; a dirty surface path waits for its
// commit unless forced (the row then records the working-copy hash). This
// module owns the state (surface, fingerprints, seal, ledger, lock);
// review-rescore-run.ts owns status, runs, deltas and rendering.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { jsonl, sha } from "./core.ts";
import type { ReviewTask } from "./review-core.ts";
import type { ArmAggregate, ArmId } from "./review-score.ts";

export const ARM_IDS: readonly ArmId[] = ["a", "b", "lane"];
export const LEDGER_FILE = "review-ledger.jsonl";
export const LOCK_FILE = "review-rescore.lock";
const LOCK_STALE_MS = 12 * 3600_000;

// ---------------------------------------------------------------- surface

export interface SurfaceArm {
	paths: string[];
	env: string[];
	/** env names the arm cannot run without (lane: the model pin) */
	required: string[];
}

export interface Surface {
	lanePlugin: string;
	minIntervalSeconds: number;
	/** a run whose transport-failed share exceeds this ledgers as failed */
	maxFailureRate: number;
	shared: string[];
	arms: Record<ArmId, SurfaceArm>;
}

interface RawArm {
	paths?: unknown;
	env?: unknown;
	required?: unknown;
}

interface RawSurface {
	lanePlugin?: unknown;
	minIntervalSeconds?: unknown;
	maxFailureRate?: unknown;
	shared?: unknown;
	arms?: Partial<Record<ArmId, RawArm>>;
}

const strings = (v: unknown, what: string): string[] => {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
		throw new Error(`review surface: ${what} must be a string array`);
	return v as string[];
};

const nonNegative = (v: unknown, what: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
		throw new Error(`review surface: ${what} must be a number >= 0`);
	return v;
};

/** Parse review-surface.json; malformed config throws (no silent defaults). */
export function loadSurface(file: string): Surface {
	const raw = JSON.parse(readFileSync(file, "utf8")) as RawSurface;
	if (typeof raw.lanePlugin !== "string" || !raw.lanePlugin)
		throw new Error("review surface: lanePlugin must name a module path");
	const arms = {} as Record<ArmId, SurfaceArm>;
	for (const arm of ARM_IDS) {
		const a = raw.arms?.[arm];
		if (!a) throw new Error(`review surface: arms.${arm} missing`);
		arms[arm] = {
			paths: strings(a.paths, `arms.${arm}.paths`),
			env: strings(a.env ?? [], `arms.${arm}.env`),
			required: strings(a.required ?? [], `arms.${arm}.required`),
		};
	}
	return {
		lanePlugin: raw.lanePlugin,
		minIntervalSeconds: nonNegative(
			raw.minIntervalSeconds,
			"minIntervalSeconds",
		),
		maxFailureRate: nonNegative(raw.maxFailureRate ?? 0, "maxFailureRate"),
		shared: strings(raw.shared ?? [], "shared"),
		arms,
	};
}

// ---------------------------------------------------------------- fingerprint

const git = (root: string, args: string[]): string => {
	const p = Bun.spawnSync(["git", "-C", root, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`git ${args[0]}: ${p.stderr.toString().trim()}`);
	return p.stdout.toString();
};

/** The commit the fingerprints were read at. */
export const headOf = (root: string): string =>
	git(root, ["rev-parse", "HEAD"]).trim();

/** Every path any arm fingerprints, sorted. */
export const surfacePaths = (s: Surface): string[] =>
	[
		...new Set([...s.shared, ...ARM_IDS.flatMap((arm) => s.arms[arm].paths)]),
	].sort();

/** HEAD blob ids for `paths` ("absent" when HEAD has no such file). */
export function headBlobs(
	root: string,
	paths: string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const p of paths) out[p] = "absent";
	if (!paths.length) return out;
	for (const rec of git(root, ["ls-tree", "-z", "HEAD", "--", ...paths]).split(
		"\0",
	)) {
		const tab = rec.indexOf("\t");
		if (tab < 0) continue;
		const [, type, blob] = rec.slice(0, tab).split(" ");
		const path = rec.slice(tab + 1);
		if (type === "blob" && blob && path in out) out[path] = blob;
	}
	return out;
}

/** Surface paths whose working copy differs from HEAD (untracked included). */
export function dirtyPaths(root: string, paths: string[]): Set<string> {
	const dirty = new Set<string>();
	if (!paths.length) return dirty;
	const want = new Set(paths);
	const out = git(root, [
		"status",
		"--porcelain",
		"-z",
		"--untracked-files=all",
		"--",
		...paths,
	]);
	for (const rec of out.split("\0")) {
		const path = rec.slice(3);
		if (want.has(path)) dirty.add(path);
	}
	return dirty;
}

export interface ArmPrint {
	fingerprint: string;
	/** `path:<p>` → blob (or `dirty:<sha16>`), `env:<NAME>` → value, `seal` */
	parts: Record<string, string>;
	dirty: string[];
}

/** One arm's fingerprint over its paths + the shared files, env pins, seal. */
export function armPrint(o: {
	root: string;
	surface: Surface;
	arm: ArmId;
	blobs: Record<string, string>;
	dirty: Set<string>;
	env: Record<string, string | undefined>;
	seal: string | null;
}): ArmPrint {
	const parts: Record<string, string> = {};
	const dirty: string[] = [];
	const spec = o.surface.arms[o.arm];
	for (const p of [...new Set([...o.surface.shared, ...spec.paths])].sort()) {
		if (o.dirty.has(p)) {
			dirty.push(p);
			const file = join(o.root, p);
			parts[`path:${p}`] = existsSync(file)
				? `dirty:${sha(readFileSync(file, "utf8")).slice(0, 16)}`
				: "dirty:deleted";
		} else parts[`path:${p}`] = o.blobs[p] ?? "absent";
	}
	for (const name of [...spec.env].sort())
		parts[`env:${name}`] = o.env[name] ?? "";
	parts.seal = o.seal ?? "none";
	return {
		fingerprint: sha(JSON.stringify(parts)).slice(0, 16),
		parts,
		dirty,
	};
}

/** Part keys whose value differs between two fingerprints. */
export function changedKeys(
	prev: Record<string, string>,
	cur: Record<string, string>,
): string[] {
	return [...new Set([...Object.keys(prev), ...Object.keys(cur)])]
		.filter((k) => prev[k] !== cur[k])
		.sort();
}

// ---------------------------------------------------------------- seal + ledger

export interface SealInfo {
	hash: string;
	ids: string[];
}

/** The sealed set, MANIFEST-verified; null when nothing is sealed. */
export function readSeal(
	dir: string,
): { tasks: ReviewTask[]; info: SealInfo } | null {
	const file = join(dir, "tasks.json");
	if (!existsSync(file)) return null;
	const body = readFileSync(file, "utf8");
	const man = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8")) as {
		hash: string;
	};
	if (sha(body).slice(0, 16) !== man.hash)
		throw new Error(`seal hash mismatch: ${file}`);
	const tasks = JSON.parse(body) as ReviewTask[];
	return { tasks, info: { hash: man.hash, ids: tasks.map((t) => t.id) } };
}

export type LedgerStatus = "scored" | "failed" | "skipped";

export interface ScoreDelta {
	/** common = both runs' rows over shared task ids; full = stored aggregates */
	basis: "common" | "full";
	n: number;
	newTasks: number | null;
	dropped: number | null;
	recall: number;
	fileRecall: number;
	fpPerTask: number;
	humanNoisePerCleanTask: number;
	verdictAccuracy: number;
	tokInP50: number | null;
}

export interface LedgerRow {
	ts: string;
	arm: ArmId;
	status: LedgerStatus;
	reason: string;
	fingerprint: string;
	parts: Record<string, string>;
	changed: string[];
	head: string;
	seal: string;
	runId: string | null;
	/** lane arm: the model pin and plugin version the run rode */
	model: string | null;
	plugin: string | null;
	/** over run-ok tasks; transport failures are counted, never scored */
	score: ArmAggregate | null;
	runFailures: number;
	prevRunId: string | null;
	delta: ScoreDelta | null;
	err?: string;
}

export async function readLedger(resDir: string): Promise<LedgerRow[]> {
	const rows: LedgerRow[] = [];
	for await (const r of jsonl<LedgerRow>(join(resDir, LEDGER_FILE)))
		rows.push(r);
	return rows;
}

export function appendLedger(resDir: string, row: LedgerRow): void {
	mkdirSync(resDir, { recursive: true });
	appendFileSync(join(resDir, LEDGER_FILE), `${JSON.stringify(row)}\n`);
}

/** The arm's newest ledger row (of `status` when given). */
export const lastRow = (
	rows: LedgerRow[],
	arm: ArmId,
	status?: LedgerStatus,
): LedgerRow | null =>
	rows.findLast((r) => r.arm === arm && (!status || r.status === status)) ??
	null;

// ---------------------------------------------------------------- lock

export interface LockInfo {
	pid: number;
	ts: number;
	reason: string;
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export function readLock(resDir: string): LockInfo | null {
	try {
		return JSON.parse(
			readFileSync(join(resDir, LOCK_FILE), "utf8"),
		) as LockInfo;
	} catch {
		return null;
	}
}

/** A lock binds while its pid lives, for at most 12h. */
export const lockLive = (lock: LockInfo, now = Date.now()): boolean =>
	now - lock.ts < LOCK_STALE_MS && alive(lock.pid);

/** Take the singleflight lock; null = a live rescore holds it. */
export function acquireLock(
	resDir: string,
	reason: string,
	now = Date.now(),
): LockInfo | null {
	mkdirSync(resDir, { recursive: true });
	const file = join(resDir, LOCK_FILE);
	const mine: LockInfo = { pid: process.pid, ts: now, reason };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
			return mine;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const held = readLock(resDir);
			if (held && lockLive(held, now)) return null;
			try {
				unlinkSync(file);
			} catch {
				// a concurrent taker removed it first
			}
		}
	}
	return null;
}

export function releaseLock(resDir: string): void {
	if (readLock(resDir)?.pid === process.pid)
		unlinkSync(join(resDir, LOCK_FILE));
}
