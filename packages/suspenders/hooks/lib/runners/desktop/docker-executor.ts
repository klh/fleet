// docker-executor.ts — W2869.3: the desktop Pi Durable executor adapter.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite0600 } from "@klh/kernel/src/kernel.atomic.module.ts";
import { z } from "zod";
import { digestOf, type RunnerSpec } from "../control/control-state.ts";
import { exportArtifacts } from "./artifact-export.ts";
import { createRemoteProcessTransport } from "./remote-process.ts";

export type DesktopProcessTransport = Awaited<
	ReturnType<typeof createRemoteProcessTransport>
>;
import {
	canonicalSeedDigest,
	IMAGE_PIN,
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

export interface DesktopExecutorDeps {
	image: string;
	seedRoot: string;
	workspacesDir: string;
	dockerBin?: string;
	runDocker?: RunArgv;
	/** Trusted host argv addressing for binary checkpoint subprocesses. */
	dockerArgv?: (argv: readonly string[]) => string[];
	/** Explicit host-owned seam. Supplying runDocker never selects a legacy path. */
	processTransportFactory?: (
		record: ExecutorRecord,
	) => Promise<DesktopProcessTransport>;
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
	/** Persisted before the first tool dispatch: an interrupted effect may
	 *  already have changed files, so it must never silently relaunch empty. */
	executed: z.boolean(),
	startedAt: z.number(),
	/** Missing only on legacy records; execution then needs explicit migration. */
	deadlineAt: z.number().int().positive().optional(),
	/** Terminal intent, retained across host reopen and concurrent record writes. */
	stopRequestedAt: z.number().int().positive().optional(),
});
export type ExecutorRecord = z.infer<typeof ExecutorRecordSchema>;

const originalDeadline = (record: ExecutorRecord): number => {
	if (record.deadlineAt === undefined)
		throw new Error(
			"desktop-runner: missing original deadline — explicit migration required",
		);
	return record.deadlineAt;
};

export interface DesktopContainer {
	start(spec: RunnerSpec, opts: { signal: AbortSignal }): Promise<void>;
	stop(runId: string): Promise<void>;
	/** Fresh handle only; preserves the checkpoint's original deadline. */
	restore(
		spec: RunnerSpec,
		opts: { signal: AbortSignal; deadlineAt: number },
	): Promise<void>;
	ensureRunning(runId: string): Promise<ExecutorRecord>;
	/** Close tool intake and prove daemon-backed quiescence, or destroy the guest. */
	quiesce(runId: string): Promise<ExecutorRecord>;
	reattach(runId: string): Promise<ExecutorRecord>;
	dispatchTool(
		runId: string,
		argv: readonly string[],
		opts?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal },
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

interface RunLifecycle {
	starting?: Promise<unknown>;
	stopping?: Promise<void>;
	stopRequestedAt?: number;
}

interface Ctx {
	deps: DesktopExecutorDeps;
	dockerBin: string;
	run: RunArgv;
	stream: (argv: string[]) => Promise<StreamRun>;
	runs: Map<string, LiveRun>;
	records: Map<string, ExecutorRecord>;
	locks: Map<string, Promise<unknown>>;
	transports: Map<
		string,
		{ containerId: string; transport: Promise<DesktopProcessTransport> }
	>;
	closed: Set<string>;
	lifecycle: Map<string, RunLifecycle>;
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
	const artifactCapBytes = deps.artifactCapBytes ?? DEFAULTS.artifactCapBytes;
	return {
		deps,
		dockerBin,
		run: deps.runDocker ?? runArgv,
		stream: deps.runDockerStream ?? runArgvStream,
		runs: new Map<string, LiveRun>(),
		records: new Map<string, ExecutorRecord>(),
		locks: new Map<string, Promise<unknown>>(),
		transports: new Map(),
		closed: new Set(),
		lifecycle: new Map(),
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
			uid: deps.uid ?? DEFAULTS.uid,
		},
	};
};

/** The policy digest THIS factory would bind at start — the canonical
 *  value spec builders stamp into RunnerSpec.policyDigest (start refuses
 *  a mismatch). Exported so callers never hand-recompute the shape. */
export const resolvedPolicyDigest = (deps: DesktopExecutorDeps): string => {
	const ctx = mkCtx(deps);
	return canonicalPolicyDigest(ctx.limits, ctx.image);
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

const lifecycleOf = (ctx: Ctx, runId: string): RunLifecycle => {
	const existing = ctx.lifecycle.get(runId);
	if (existing) return existing;
	const state: RunLifecycle = {};
	ctx.lifecycle.set(runId, state);
	return state;
};

const saveRecord = async (ctx: Ctx, record: ExecutorRecord): Promise<void> => {
	await mkdir(join(ctx.deps.workspacesDir, record.runId), { recursive: true });
	const stopRequestedAt =
		record.stopRequestedAt ?? lifecycleOf(ctx, record.runId).stopRequestedAt;
	const persisted =
		stopRequestedAt === undefined ? record : { ...record, stopRequestedAt };
	await atomicWrite0600(
		recordPathOf(ctx, record.runId),
		`${JSON.stringify(persisted)}\n`,
	);
	ctx.records.set(record.runId, persisted);
};

const relaunchArgv = (ctx: Ctx, spec: RunnerSpec): string[] => {
	const name = containerNameOf(spec.runId);
	const seedDir = join(ctx.deps.workspacesDir, spec.runId, "seed");
	const lim = ctx.limits;
	const isolation = [
		"run",
		"-d",
		"--name",
		name,
		"--rm",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--user",
		`${lim.uid}:${lim.uid}`,
		"--network",
		"none",
	];
	const resources = [
		"--memory",
		`${lim.memoryMb}m`,
		"--memory-swap",
		`${lim.memoryMb}m`,
		"--cpus",
		String(lim.cpus),
		"--pids-limit",
		String(lim.pidsLimit),
	];
	const mounts = [
		"--tmpfs",
		`/tmp:rw,noexec,nosuid,size=${lim.tmpMb}m,uid=${lim.uid},gid=${lim.uid}`,
		"--tmpfs",
		`/workspace:rw,noexec,nosuid,size=${lim.workMb}m,uid=${lim.uid},gid=${lim.uid}`,
		"-v",
		`${seedDir}:/seed:ro`,
	];
	const idle = ctx.deps.idleCommand ?? ["sleep", "infinity"];
	// docker run: IMAGE before COMMAND — the idle command is the container
	// command riding the image, never the reverse (root #117912.1).
	return [
		ctx.dockerBin,
		...isolation,
		...resources,
		...mounts,
		ctx.image,
		...idle,
	];
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
	opts.signal.throwIfAborted();
	if (ctx.closed.has(spec.runId))
		throw new Error("desktop-runner: run stopped");
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
	if (existing) {
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
	opts: { signal: AbortSignal; deadlineAt?: number },
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
	const startedAt = Date.now();
	const record: ExecutorRecord = {
		runId: spec.runId,
		containerName: containerNameOf(spec.runId),
		containerId,
		image: ctx.image,
		seedDir,
		argv,
		expired: false,
		executed: false,
		startedAt,
		deadlineAt: opts.deadlineAt ?? startedAt + ctx.limits.deadlineMs,
	};
	// Retain the daemon identity before persistence can fail, so rollback
	// and a later stop retry can always address the guest we just created.
	ctx.records.set(spec.runId, record);
	try {
		await saveRecord(ctx, record);
		armRun(ctx, spec.runId, record, opts.signal);
		opts.signal.throwIfAborted();
		if (ctx.closed.has(spec.runId))
			throw new Error("desktop-runner: run stopped");
		await transportFor(ctx, record);
		opts.signal.throwIfAborted();
		if (ctx.closed.has(spec.runId))
			throw new Error("desktop-runner: run stopped");
	} catch (error) {
		try {
			await stopRun(ctx, spec.runId);
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				"desktop-runner: runtime prerequisites and cleanup failed",
			);
		}
		throw error;
	}
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
			void stopTracked(ctx, runId);
		},
		signal,
	};
	signal.addEventListener("abort", entry.onAbort);
	const timer = setTimeout(
		() => {
			entry.expired = true;
			void expireRun(ctx, runId);
		},
		Math.max(0, originalDeadline(record) - Date.now()),
	);
	timer.unref();
	entry.timer = timer;
	ctx.runs.set(runId, entry);
};

const expireRun = async (ctx: Ctx, runId: string): Promise<void> => {
	if (ctx.closed.has(runId)) return;
	const record = ctx.records.get(runId) ?? (await loadRecord(ctx, runId));
	if (record && !record.expired) {
		await saveRecord(ctx, { ...record, expired: true });
	}
	await stopTracked(ctx, runId);
};

const stopRun = async (ctx: Ctx, runId: string): Promise<void> => {
	ctx.closed.add(runId);
	lifecycleOf(ctx, runId).stopRequestedAt ??= Date.now();
	const entry = ctx.runs.get(runId);
	if (entry) {
		if (entry.timer) clearTimeout(entry.timer);
		entry.signal.removeEventListener("abort", entry.onAbort);
		ctx.runs.delete(runId);
	}
	const cached = ctx.transports.get(runId);
	ctx.transports.delete(runId);
	const cleanupFailures: unknown[] = [];
	// Memory may hold a newly created recovery guest whose record write
	// failed; an older disk record must not replace that cleanup target.
	const record = ctx.records.get(runId) ?? (await loadRecord(ctx, runId));
	if (record) {
		try {
			const disk = await readFile(recordPathOf(ctx, runId), "utf8").then(
				(raw) => ExecutorRecordSchema.parse(JSON.parse(raw)),
				() => null,
			);
			if (!disk || disk.containerId === record.containerId)
				await saveRecord(ctx, record);
		} catch (error) {
			cleanupFailures.push(error);
		}
	}
	try {
		if (cached) await (await cached.transport).cleanup();
	} catch (error) {
		cleanupFailures.push(error);
	}
	const containerId =
		record?.containerId ?? entry?.containerId ?? cached?.containerId;
	if (!containerId) return;
	const stopped = await ctx.run([
		ctx.dockerBin,
		"stop",
		"-t",
		String(ctx.limits.stopTimeoutS),
		containerId,
	]);
	if (stopped.code !== 0 && !dockerGone(stopped)) {
		throw new AggregateError(
			[...cleanupFailures, new Error(stopped.stderr.trim())],
			"desktop-runner: container stop failed",
		);
	}
	if (cleanupFailures.length)
		throw new AggregateError(
			cleanupFailures,
			"desktop-runner: transport cleanup failed",
		);
};

/** Bounded one-shot tool dispatch INTO the sandbox: argv-only, stdin for
 *  tool payload bytes, hard timeout — the conversation never rides this
 *  path; the container has no network and holds no keys. */
const transportFor = async (
	ctx: Ctx,
	record: ExecutorRecord,
): Promise<DesktopProcessTransport> => {
	const cached = ctx.transports.get(record.runId);
	if (cached?.containerId === record.containerId) return cached.transport;
	if (cached) await (await cached.transport).cleanup();
	const transport = ctx.deps.processTransportFactory
		? ctx.deps.processTransportFactory(record)
		: createRemoteProcessTransport({
				containerId: record.containerId,
				expectedPinnedImageRef: record.image,
				deadlineAt: originalDeadline(record),
				dockerBin: ctx.dockerBin,
			});
	ctx.transports.set(record.runId, {
		containerId: record.containerId,
		transport,
	});
	try {
		return await transport;
	} catch (error) {
		if (ctx.transports.get(record.runId)?.transport === transport)
			ctx.transports.delete(record.runId);
		throw error;
	}
};

const execIn = async (
	ctx: Ctx,
	record: ExecutorRecord,
	argv: readonly string[],
	opts?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<RunOutput> => {
	// Persist before crossing the effect boundary: a failed or interrupted
	// command can still have changed the workspace.
	if (!record.executed) await saveRecord(ctx, { ...record, executed: true });
	const transport = await transportFor(ctx, record);
	if (ctx.closed.has(record.runId))
		throw new Error("desktop-runner: tool intake closed");
	return transport.run(argv, {
		...opts,
		timeoutMs: opts?.timeoutMs ?? ctx.limits.submitTimeoutMs,
	});
};

const relaunchFromRecord = async (
	ctx: Ctx,
	record: ExecutorRecord,
): Promise<ExecutorRecord> => {
	await ctx.run([ctx.dockerBin, "rm", "-f", record.containerName]);
	const res = await ctx.run(record.argv);
	if (res.code !== 0) {
		throw new Error(`desktop-runner: relaunch failed — ${res.stderr.trim()}`);
	}
	const containerId = res.stdout.trim();
	if (containerId.length === 0) {
		throw new Error("desktop-runner: relaunch returned no id");
	}
	const fresh = { ...record, containerId };
	ctx.records.set(record.runId, fresh);
	try {
		await saveRecord(ctx, fresh);
		return fresh;
	} catch (error) {
		try {
			await stopRun(ctx, record.runId);
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				"desktop-runner: recovery persistence and cleanup failed",
			);
		}
		throw error;
	}
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
	if (record.expired || originalDeadline(record) <= Date.now()) {
		await saveRecord(ctx, { ...record, expired: true });
		await stopRun(ctx, runId);
		throw new Error(
			`desktop-runner: run ${runId} deadline expired — refusing relaunch`,
		);
	}
	const alive = await containerRunning(ctx, record.containerName);
	if (ctx.closed.has(runId) || record.stopRequestedAt !== undefined)
		throw new Error(
			"desktop-runner: run stopped — explicit authorized restore required",
		);
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
	const restarted = await ctx.run([ctx.dockerBin, "start", record.containerId]);
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
	const fresh = await trackGuestStart(ctx, runId, () =>
		ensureRunning(ctx, runId),
	);
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

const quiesceRun = async (ctx: Ctx, runId: string): Promise<ExecutorRecord> => {
	ctx.closed.add(runId);
	try {
		const record = await loadRecord(ctx, runId);
		if (
			!record ||
			record.stopRequestedAt !== undefined ||
			record.expired ||
			originalDeadline(record) <= Date.now() ||
			!(await containerRunning(ctx, record.containerId))
		)
			throw new Error(
				"desktop-runner: stopped or unavailable guest cannot quiesce",
			);
		const transport = await transportFor(ctx, record);
		await transport.cleanup();
		await withRunLock(ctx, runId, () => transport.assertQuiescent());
		return record;
	} catch (error) {
		try {
			await stopTracked(ctx, runId);
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				"desktop-runner: quiescence and guest destruction failed",
			);
		}
		throw error;
	}
};

/** The one desktop carrier: constrained lifecycle + bounded tool dispatch
 *  + exec-tar artifact export under the per-run lock. The DurableAdapter
 *  composition over the HOST-side durable job lives in wiring.ts. */
const trackGuestStart = async <T>(
	ctx: Ctx,
	runId: string,
	operation: () => Promise<T>,
): Promise<T> => {
	const state = lifecycleOf(ctx, runId);
	if (ctx.closed.has(runId) || state.stopRequestedAt !== undefined)
		throw new Error("desktop-runner: run stopped");
	if (state.starting) throw new Error("desktop-runner: startup in progress");
	const pending = operation();
	state.starting = pending;
	try {
		const result = await pending;
		if (ctx.closed.has(runId)) throw new Error("desktop-runner: run stopped");
		return result;
	} finally {
		if (state.starting === pending) delete state.starting;
	}
};

const stopTracked = async (ctx: Ctx, runId: string): Promise<void> => {
	const state = lifecycleOf(ctx, runId);
	ctx.closed.add(runId);
	state.stopRequestedAt ??= Date.now();
	if (state.stopping) return state.stopping;
	const pending = (async () => {
		if (state.starting) await state.starting.catch(() => {});
		await stopRun(ctx, runId);
	})();
	state.stopping = pending;
	try {
		await pending;
	} finally {
		if (state.stopping === pending) delete state.stopping;
	}
};

export const createDesktopDockerExecutor = (
	deps: DesktopExecutorDeps,
): DesktopContainer => {
	const ctx = mkCtx(deps);
	return {
		restore: (spec, opts) =>
			trackGuestStart(ctx, spec.runId, async () => {
				if (opts.deadlineAt <= Date.now())
					throw new Error("checkpoint: original deadline expired");
				if (resolvedPolicyDigest(deps) !== spec.policyDigest)
					throw new Error("checkpoint: policy drift");
				const files = await scanSeedDir(deps.seedRoot);
				if (canonicalSeedDigest(files) !== spec.seedDigest)
					throw new Error("checkpoint: seed drift");
				await launchContainer(ctx, spec, files, opts);
			}),
		start: (spec, opts) =>
			trackGuestStart(ctx, spec.runId, () => startRun(ctx, spec, opts)),
		stop: (runId) => stopTracked(ctx, runId),
		ensureRunning: (runId) =>
			trackGuestStart(ctx, runId, () => ensureRunning(ctx, runId)),
		quiesce: (runId) => quiesceRun(ctx, runId),
		reattach: (runId) =>
			trackGuestStart(ctx, runId, async () => {
				const record = await ensureRunning(ctx, runId);
				const transport = await transportFor(ctx, record);
				await transport.cleanup();
				await transport.assertQuiescent();
				ctx.transports.delete(runId);
				return record;
			}),
		dispatchTool: (runId, argv, opts) =>
			withRunLock(ctx, runId, async () => {
				if (ctx.closed.has(runId))
					throw new Error("desktop-runner: tool intake closed");
				const record = await trackGuestStart(ctx, runId, () =>
					ensureRunning(ctx, runId),
				);
				return execIn(ctx, record, argv, opts);
			}),
		copyOutArtifacts: (runId, destDir) =>
			withRunLock(ctx, runId, () => copyOutRun(ctx, runId, destDir)),
		runRecord: (runId) => ctx.records.get(runId) ?? null,
	};
};
