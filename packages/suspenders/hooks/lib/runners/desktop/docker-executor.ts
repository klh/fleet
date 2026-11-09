// docker-executor.ts — W2869.3: the desktop Pi Durable executor adapter.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { z } from "zod";
import { digestOf, type RunnerSpec } from "../control/control-state.ts";
import {
	IMAGE_PIN,
	canonicalSeedDigest,
	materializeSnapshot,
	scanSeedDir,
	verifySnapshotDigest,
} from "./seed.ts";
import {
	type RunArgv,
	type RunOutput,
	runArgv,
	runArgvStream,
	type StreamRun,
} from "./spawn.ts";
import { exportArtifacts } from "./artifact-export.ts";

export interface DesktopExecutorDeps {
	image: string;
	seedRoot: string;
	workspacesDir: string;
	dockerBin?: string;
	runDocker?: RunArgv;
	memoryMb?: number;
	cpus?: number;
	pidsLimit?: number;
	deadlineMs?: number;
	workMb?: number;
	tmpMb?: number;
	stopTimeoutS?: number;
	submitTimeoutMs?: number;
	/** Container uid:gid for the unprivileged `--user` pair; tmpfs mounts
	 *  are chowned to match so the non-root user can write /workspace. */
	uid?: number;
	submitCommand?: readonly string[];
	resumeCommand?: readonly string[];
	idleCommand?: readonly string[];
	artifactCapBytes?: number;
	runDockerStream?: (argv: string[]) => Promise<StreamRun>;
}

const DEFAULTS = {
	memoryMb: 512,
	cpus: 1,
	pidsLimit: 128,
	deadlineMs: 30 * 60 * 1000,
	workMb: 128,
	tmpMb: 64,
	stopTimeoutS: 10,
	submitTimeoutMs: 30_000,
	artifactCapBytes: 32 * 1024 * 1024,
	uid: 1000,
} as const;

const CONTAINER_RECORD = "executor.json";

export const containerNameOf = (runId: string): string =>
	`fleet-runner-${runId.replaceAll("-", "").slice(0, 16)}`;

const dockerGone = (r: { code: number; stderr: string }): boolean =>
	r.code !== 0 && /No such container/.test(r.stderr);

const containerGone = async (ctx: Ctx, ref: string): Promise<boolean> => {
	const r = await ctx.run([
		ctx.dockerBin,
		"inspect",
		"-f",
		"{{.State.Running}}",
		ref,
	]);
	return dockerGone(r);
};

/** The crash-reopen record: bit-for-bit argv + seed mount so a relaunched
 *  container is behaviorally identical to the one it replaces. */
export const ExecutorRecordSchema = z.strictObject({
	runId: z.string().min(1),
	containerName: z.string().min(1),
	containerId: z.string().min(1),
	image: z.string().min(1),
	seedDir: z.string().min(1),
	argv: z.array(z.string()),
	expired: z.boolean(),
	/** Stamped on the first successful tool dispatch — a run that has
	 *  executed at least once may never silently relaunch empty. */
	executed: z.boolean(),
	startedAt: z.number(),
});
export type ExecutorRecord = z.infer<typeof ExecutorRecordSchema>;

export interface DesktopContainer {
	start(spec: RunnerSpec, opts: { signal: AbortSignal }): Promise<void>;
	stop(runId: string): Promise<void>;
	ensureRunning(runId: string): Promise<ExecutorRecord>;
	dispatchTool(
		runId: string,
		argv: readonly string[],
		opts?: { stdin?: string; timeoutMs?: number },
	): Promise<RunOutput>;
	copyOutArtifacts(
		runId: string,
		destDir: string,
	): Promise<{ files: number; bytes: number }>;
	runRecord(runId: string): ExecutorRecord | null;
}

interface LiveRun {
	containerId: string;
	containerName: string;
	seedDir: string;
	timer: ReturnType<typeof setTimeout> | null;
	expired: boolean;
	onAbort: () => void;
	signal: AbortSignal;
}

interface Ctx {
	deps: DesktopExecutorDeps;
	dockerBin: string;
	run: RunArgv;
	stream: (argv: string[]) => Promise<StreamRun>;
	runs: Map<string, LiveRun>;
	records: Map<string, ExecutorRecord>;
	locks: Map<string, Promise<unknown>>;
	image: string;
	limits: {
		memoryMb: number;
		cpus: number;
		pidsLimit: number;
		deadlineMs: number;
		workMb: number;
		tmpMb: number;
		stopTimeoutS: number;
		submitTimeoutMs: number;
		artifactCapBytes: number;
		uid: number;
	};
}

const mkCtx = (deps: DesktopExecutorDeps): Ctx => {
	const dockerBin = deps.dockerBin ?? "docker";
	const memoryMb = deps.memoryMb ?? DEFAULTS.memoryMb;
	const cpus = deps.cpus ?? DEFAULTS.cpus;
	const pidsLimit = deps.pidsLimit ?? DEFAULTS.pidsLimit;
	const deadlineMs = deps.deadlineMs ?? DEFAULTS.deadlineMs;
	const workMb = deps.workMb ?? DEFAULTS.workMb;
	const tmpMb = deps.tmpMb ?? DEFAULTS.tmpMb;
	const stopTimeoutS = deps.stopTimeoutS ?? DEFAULTS.stopTimeoutS;
	const submitTimeoutMs = deps.submitTimeoutMs ?? DEFAULTS.submitTimeoutMs;
	const artifactCapBytes =
		deps.artifactCapBytes ?? DEFAULTS.artifactCapBytes;
	return {
		deps,
		dockerBin,
		run: deps.runDocker ?? runArgv,
		stream: deps.runDockerStream ?? runArgvStream,
		runs: new Map<string, LiveRun>(),
		records: new Map<string, ExecutorRecord>(),
		locks: new Map<string, Promise<unknown>>(),
		image: deps.image,
		limits: {
			memoryMb,
			cpus,
			pidsLimit,
			deadlineMs,
			workMb,
			tmpMb,
			stopTimeoutS,
			submitTimeoutMs,
			artifactCapBytes,
		},
	};
};

const recordPathOf = (ctx: Ctx, runId: string): string =>
	join(ctx.deps.workspacesDir, runId, CONTAINER_RECORD);

const loadRecord = async (
	ctx: Ctx,
	runId: string,
): Promise<ExecutorRecord | null> => {
	try {
		const raw = await readFile(recordPathOf(ctx, runId), "utf8");
		const parsed = ExecutorRecordSchema.parse(JSON.parse(raw));
		ctx.records.set(runId, parsed);
		return parsed;
	} catch {
		return null;
	}
};

const saveRecord = async (ctx: Ctx, record: ExecutorRecord): Promise<void> => {
	await mkdir(join(ctx.deps.workspacesDir, record.runId), {
		recursive: true,
	});
	await atomicWrite0600(
		recordPathOf(ctx, record.runId),
		`${JSON.stringify(record)}\n`,
	);
	ctx.records.set(record.runId, record);
};

const relaunchArgv = (ctx: Ctx, spec: RunnerSpec): string[] => {
	const name = containerNameOf(spec.runId);
	const seedDir = join(ctx.deps.workspacesDir, spec.runId, "seed");
	const lim = ctx.limits;
	const isolation = [
		"run", "-d", "--name", name, "--rm", "--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--user", `${lim.uid}:${lim.uid}`,
		"--network", "none",
	];
	const resources = [
		"--memory", `${lim.memoryMb}m`,
		"--memory-swap", `${lim.memoryMb}m`,
		"--cpus", String(lim.cpus),
		"--pids-limit", String(lim.pidsLimit),
	];
	const mounts = [
		"--tmpfs", `/tmp:rw,noexec,nosuid,size=${lim.tmpMb}m,uid=${lim.uid},gid=${lim.uid}`,
		"--tmpfs", `/workspace:rw,noexec,nosuid,size=${lim.workMb}m,uid=${lim.uid},gid=${lim.uid}`,
		"-v", `${seedDir}:/seed:ro`,
	];
	const idle = ctx.deps.idleCommand ?? ["sleep", "infinity"];
	// docker run: IMAGE before COMMAND — the idle command is the container
	// command riding the image, never the reverse (root #117912.1).
	return [ctx.dockerBin, ...isolation, ...resources, ...mounts, ctx.image, ...idle];
};

const containerRunning = async (
	ctx: Ctx,
	containerName: string,
): Promise<boolean> => {
	const r = await ctx.run([
		ctx.dockerBin,
		"inspect",
		"-f",
		"{{.State.Running}}",
		containerName,
	]);
	return r.code === 0 && r.stdout.trim() === "true";
};

/** The executable policy digest — recomputed from the ACTUAL resolved
 *  launch parameters (digest-pinned image + isolation limits) so a spec
 *  minted against different limits refuses at start instead of launching
 *  a weaker sandbox (root #117939). */
export const canonicalPolicyDigest = (
	lim: {
		memoryMb: number;
		cpus: number;
		pidsLimit: number;
		workMb: number;
		tmpMb: number;
		uid: number;
	},
	image: string,
): string =>
	digestOf(
		JSON.stringify({
			image,
			network: "none",
			readOnlyRoot: true,
			capDropAll: true,
			noNewPrivileges: true,
			user: `${lim.uid}:${lim.uid}`,
			memoryMb: lim.memoryMb,
			cpus: lim.cpus,
			pidsLimit: lim.pidsLimit,
			workMb: lim.workMb,
			tmpMb: lim.tmpMb,
		}),
	);

const startRun = async (
	ctx: Ctx,
	spec: RunnerSpec,
	opts: { signal: AbortSignal },
): Promise<void> => {
	if (ctx.runs.has(spec.runId)) {
		throw new Error(`desktop-runner: run ${spec.runId} already started`);
	}
	if (!IMAGE_PIN.test(ctx.image)) {
		throw new Error(
			`desktop-runner: runtime image must be digest-pinned — got ${ctx.image}`,
		);
	}
	const files = await scanSeedDir(ctx.deps.seedRoot);
	const seedDigest = canonicalSeedDigest(files);
	if (seedDigest !== spec.seedDigest) {
		throw new Error(
			`desktop-runner: seed drift — seed root digests to ${seedDigest}, spec binds ${spec.seedDigest} — a newer seed is a newer runId`,
		);
	}
	const policy = canonicalPolicyDigest(ctx.limits, ctx.image);
	if (policy !== spec.policyDigest) {
		throw new Error(
			`desktop-runner: policy drift — actual launch parameters digest to ${policy}, spec binds ${spec.policyDigest} — refuse to launch a weaker sandbox`,
		);
	}
	const existing = await loadRecord(ctx, spec.runId);
	if (existing && !existing.expired) {
		throw new Error(
			`desktop-runner: run ${spec.runId} already started (container ${existing.containerName})`,
		);
	}
	await launchContainer(ctx, spec, files, opts);
};

const launchContainer = async (
	ctx: Ctx,
	spec: RunnerSpec,
	files: Awaited<ReturnType<typeof scanSeedDir>>,
	opts: { signal: AbortSignal },
): Promise<void> => {
	const runRoot = join(ctx.deps.workspacesDir, spec.runId);
	const seedDir = join(runRoot, "seed");
	await materializeSnapshot(files, seedDir);
	await verifySnapshotDigest(seedDir, spec.seedDigest);
	const argv = relaunchArgv(ctx, spec);
	const res = await ctx.run(argv);
	if (res.code !== 0) {
		throw new Error(
			`desktop-runner: container start failed — ${res.stderr.trim()}`,
		);
	}
	const containerId = res.stdout.trim();
	if (containerId.length === 0) {
		throw new Error("desktop-runner: container start returned no id");
	}
	const record: ExecutorRecord = {
		runId: spec.runId,
		containerName: containerNameOf(spec.runId),
		containerId,
		image: ctx.image,
		seedDir,
		argv,
		expired: false,
		executed: false,
		startedAt: Date.now(),
	};
	await saveRecord(ctx, record);
	armRun(ctx, spec.runId, record, opts.signal);
};

const armRun = (
	ctx: Ctx,
	runId: string,
	record: ExecutorRecord,
	signal: AbortSignal,
): void => {
	const entry: LiveRun = {
		containerId: record.containerId,
		containerName: record.containerName,
		seedDir: record.seedDir,
		timer: null,
		expired: false,
		onAbort: () => {
			void stopRun(ctx, runId);
		},
		signal,
	};
	signal.addEventListener("abort", entry.onAbort);
	const timer = setTimeout(() => {
		entry.expired = true;
		void expireRun(ctx, runId);
	}, ctx.limits.deadlineMs);
	timer.unref();
	entry.timer = timer;
	ctx.runs.set(runId, entry);
};

const expireRun = async (ctx: Ctx, runId: string): Promise<void> => {
	const record = await loadRecord(ctx, runId);
	if (record && !record.expired) {
		await saveRecord(ctx, { ...record, expired: true });
	}
	await stopRun(ctx, runId);
};

const stopRun = async (ctx: Ctx, runId: string): Promise<void> => {
	const entry = ctx.runs.get(runId);
	if (entry) {
		if (entry.timer) clearTimeout(entry.timer);
		entry.signal.removeEventListener("abort", entry.onAbort);
		ctx.runs.delete(runId);
	}
	const record = await loadRecord(ctx, runId);
	if (!record) return;
	const stopped = await ctx.run([
		ctx.dockerBin,
		"stop",
		"-t",
		String(ctx.limits.stopTimeoutS),
		record.containerId,
	]);
	if (stopped.code !== 0 && !dockerGone(stopped)) {
		throw new Error(
			`desktop-runner: container stop failed — ${stopped.stderr.trim()}`,
		);
	}
};

/** Bounded one-shot tool dispatch INTO the sandbox: argv-only, stdin for
 *  tool payload bytes, hard timeout — the conversation never rides this
 *  path; the container has no network and holds no keys. */
const execIn = async (
	ctx: Ctx,
	record: ExecutorRecord,
	argv: readonly string[],
	opts?: { stdin?: string; timeoutMs?: number },
): Promise<RunOutput> =>
	ctx.run([ctx.dockerBin, "exec", "-i", record.containerId, ...argv], {
		stdin: opts?.stdin,
		timeoutMs: opts?.timeoutMs ?? ctx.limits.submitTimeoutMs,
	});

const relaunchFromRecord = async (
	ctx: Ctx,
	record: ExecutorRecord,
): Promise<ExecutorRecord> => {
	await ctx.run([ctx.dockerBin, "rm", "-f", record.containerName]);
	const res = await ctx.run(record.argv);
	if (res.code !== 0) {
		throw new Error(
			`desktop-runner: relaunch failed — ${res.stderr.trim()}`,
		);
	}
	const containerId = res.stdout.trim();
	if (containerId.length === 0) {
		throw new Error("desktop-runner: relaunch returned no id");
	}
	const fresh = { ...record, containerId };
	await saveRecord(ctx, fresh);
	return fresh;
};

const ensureRunning = async (
	ctx: Ctx,
	runId: string,
): Promise<ExecutorRecord> => {
	const record = await loadRecord(ctx, runId);
	if (!record) {
		throw new Error(
			`desktop-runner: run ${runId} has no executor record — start it first`,
		);
	}
	if (
		record.expired ||
		ctx.limits.deadlineMs - (Date.now() - record.startedAt) <= 0
	) {
		await saveRecord(ctx, { ...record, expired: true });
		await stopRun(ctx, runId);
		throw new Error(
			`desktop-runner: run ${runId} deadline expired — refusing relaunch`,
		);
	}
	const alive = await containerRunning(ctx, record.containerName);
	if (alive) return record;
	// Root #117942: /workspace tmpfs survives only while the SAME container
	// lives. A container lost after at least one executed tool call is
	// workspace-lost — relaunching would hand the model an empty /workspace
	// as if its files never existed. Refuse; the durable job fails closed.
	if (record.executed && (await containerGone(ctx, record.containerId))) {
		throw new Error(
			`desktop-runner: workspace-lost — container ${record.containerName} died after tool execution; /workspace state is unrecoverable — run fails closed`,
		);
	}
	const restarted = await ctx.run([
		ctx.dockerBin,
		"start",
		record.containerId,
	]);
	if (restarted.code === 0) return record;
	if (!dockerGone(restarted)) {
		throw new Error(
			`desktop-runner: container start failed — ${restarted.stderr.trim()}`,
		);
	}
	return relaunchFromRecord(ctx, record);
};

/** Serialize dispatch + export per run: a paused container must never
 *  freeze an in-flight tool exec past its own timeout. */
const withRunLock = async <T>(
	ctx: Ctx,
	runId: string,
	fn: () => Promise<T>,
): Promise<T> => {
	const prev = ctx.locks.get(runId) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	ctx.locks.set(runId, next);
	try {
		return await next;
	} finally {
		if (ctx.locks.get(runId) === next) ctx.locks.delete(runId);
	}
};

const copyOutRun = async (
	ctx: Ctx,
	runId: string,
	destDir: string,
): Promise<{ files: number; bytes: number }> => {
	const fresh = await ensureRunning(ctx, runId);
	// Root #117946: no freeze — a paused tmpfs is invisible to the export
	// and the exec route reads the LIVE workspace safely under the per-run
	// lock (dispatch and export serialize).
	return await exportArtifacts({
		dockerBin: ctx.dockerBin,
		containerRef: fresh.containerId,
		destDir,
		capBytes: ctx.limits.artifactCapBytes,
		run: ctx.stream,
	});
};

/** The one desktop carrier: constrained lifecycle + bounded tool dispatch
 *  + exec-tar artifact export under the per-run lock. The DurableAdapter
 *  composition over the HOST-side durable job lives in wiring.ts. */
export const createDesktopDockerExecutor = (
	deps: DesktopExecutorDeps,
): DesktopContainer => {
	const ctx = mkCtx(deps);
	return {
		start: (spec, opts) => startRun(ctx, spec, opts),
		stop: (runId) => stopRun(ctx, runId),
		ensureRunning: (runId) => ensureRunning(ctx, runId),
		dispatchTool: (runId, argv, opts) =>
			withRunLock(ctx, runId, async () => {
				const record = await ensureRunning(ctx, runId);
				return execIn(ctx, record, argv, opts);
			}),
		copyOutArtifacts: (runId, destDir) =>
			withRunLock(ctx, runId, () => copyOutRun(ctx, runId, destDir)),
		runRecord: (runId) => ctx.records.get(runId) ?? null,
	};
};
