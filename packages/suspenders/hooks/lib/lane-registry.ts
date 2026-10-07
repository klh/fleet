import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { HARNESS_ARG_RE } from "./lane-liveness.ts";
import { basename, dirname, join, resolve } from "node:path";

export interface RegistryLane {
	sid: string;
	attempt?: number;
	launchedAt?: number;
}

/** Git's common directory identifies the primary checkout, including linked worktrees. */
export function canonicalProjectRoot(input: string): string {
	let root = resolve(input);
	if (basename(root) === "lanes.json") root = dirname(root);
	if (basename(root) === ".fleet") root = dirname(root);
	const git = Bun.spawnSync(
		[
			"git",
			"-C",
			root,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (git.exitCode !== 0) return existsSync(root) ? realpathSync(root) : root;
	const common = realpathSync(git.stdout.toString().trim());
	if (basename(common) === ".git") return dirname(common);
	const worktrees = Bun.spawnSync(
		["git", "-C", root, "worktree", "list", "--porcelain"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const primary = worktrees.stdout
		.toString()
		.split("\n")
		.find((line) => line.startsWith("worktree "))
		?.slice(9);
	if (!primary) throw new Error(`Cannot resolve primary checkout for ${root}`);
	return realpathSync(primary);
}

export const laneRegistryFile = (input: string): string =>
	join(canonicalProjectRoot(input), ".fleet", "lanes.json");
export type RegistryRead<T> =
	| { known: true; lanes: T[] }
	| { known: false; lanes: []; error: string };
function readFile<T extends RegistryLane>(file: string): RegistryRead<T> {
	if (!existsSync(file))
		return { known: false, lanes: [], error: "registry missing" };
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (
			!Array.isArray(parsed) ||
			parsed.some(
				(row) => !row || typeof row !== "object" || typeof row.sid !== "string",
			)
		)
			throw new Error("invalid registry rows");
		return { known: true, lanes: parsed as T[] };
	} catch (error) {
		return { known: false, lanes: [], error: String(error) };
	}
}
export function readLaneRegistry<T extends RegistryLane>(
	input: string,
): RegistryRead<T> {
	return readFile<T>(laneRegistryFile(input));
}
export function loadLaneRegistryFile<T extends RegistryLane>(
	file: string,
): T[] {
	const state = readFile<T>(resolve(file));
	if (!state.known && existsSync(file))
		throw new Error(`Cannot read lane registry: ${state.error}`);
	return state.lanes;
}
export function loadLaneRegistry<T extends RegistryLane>(input: string): T[] {
	return loadLaneRegistryFile<T>(laneRegistryFile(input));
}

export function newerLane<T extends RegistryLane>(current: T, incoming: T): T {
	const attempts = (incoming.attempt ?? 0) - (current.attempt ?? 0);
	if (
		attempts < 0 ||
		(attempts === 0 && (incoming.launchedAt ?? 0) < (current.launchedAt ?? 0))
	)
		return current;
	return incoming;
}

/** Snapshots are upserts, never deletion authority. Re-read under the cross-process lock. */
export function mergeLaneRegistry<T extends RegistryLane>(
	input: string,
	incoming: T[],
): void {
	const file = laneRegistryFile(input),
		lock = `${file}.lock`;
	mkdirSync(dirname(file), { recursive: true });
	const deadline = Date.now() + 5000;
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new Error(
					`Lane registry lock unavailable: ${lock}; inspect its owner before recovery`,
				);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
		}
	}
	const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(
			join(lock, "owner.json"),
			JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
			{ mode: 0o600 },
		);
		const state = readFile<T>(file);
		if (!state.known && existsSync(file))
			throw new Error(
				`Refusing to overwrite unreadable lane registry: ${state.error}`,
			);
		const rows = new Map<string, T>();
		for (const row of [...state.lanes, ...incoming]) {
			if (!row || typeof row.sid !== "string")
				throw new Error("Invalid incoming lane");
			const previous = rows.get(row.sid);
			rows.set(row.sid, previous ? newerLane(previous, row) : row);
		}
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, JSON.stringify([...rows.values()], null, 2));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, file);
	} finally {
		rmSync(temp, { force: true });
		rmSync(lock, { recursive: true, force: true });
	}
}

/** Unknown observations never authorize filesystem destruction. */
export function safeToRetire(input: {
	registryKnown: boolean;
	claimKnown: boolean;
	claimed: boolean;
	recentlyLaunched: boolean;
	live: boolean | null;
}): boolean {
	return (
		input.registryKnown &&
		input.claimKnown &&
		!input.claimed &&
		!input.recentlyLaunched &&
		input.live === false
	);
}

/** Destructive sweeps distinguish a failed process probe from an observed absence. */
export function retirementProcessLive(worktree: string): boolean | null {
	try {
		const processes = Bun.spawnSync(["ps", "-axo", "pid=,args="], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (processes.exitCode !== 0) return null;
		const pids = processes.stdout
			.toString()
			.split("\n")
			.filter((line) => HARNESS_ARG_RE.test(line))
			.map((line) => line.trim().split(/\s+/)[0]);
		if (!pids.length) return false;
		const cwd = Bun.spawnSync(
			["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fn"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (cwd.exitCode !== 0) return null;
		return cwd.stdout
			.toString()
			.split("\n")
			.some(
				(line) => line === `n${worktree}` || line.startsWith(`n${worktree}/`),
			);
	} catch {
		return null;
	}
}
