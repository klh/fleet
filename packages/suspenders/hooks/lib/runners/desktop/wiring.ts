// wiring.ts — W2869.3: the desktop runner leaf factory — the ONE place
// where the desktop executor, per-run credentials, the W2869.1 durable job
// and the W2869.2 controller compose into a servable runner service.
// v1 is ONE desktop host (this Mac's Docker Desktop), labeled honestly:
// the control store is local SQLite — no cross-hub lease, no cross-machine
// failover claim (root #117939). The leaf's control actions ride the host
// actor's runner scopes; every model fetch and tool dispatch inside the
// durable job fences the executor's CURRENT lease token (execute rides
// nothing user-shaped — root #117699).
import { randomUUID } from "node:crypto";
import { openHandoffState } from "../control/handoff-state.ts";
import { createLeafHandoff, type OwnedExecution } from "./leaf-handoff.ts";
import { captureExecutionAuthority } from "./execution-authority.ts";
import {
	createRegistry,
	defineExtension,
	defineTool,
	type HarnessOptions,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { type RunnerSpec, RunnerSpecSchema } from "../control/control-state.ts";
import {
	type DurableAdapter,
	openRunnerController,
	type RunnerController,
} from "../control/controller.ts";
import { getLease, type LeaseToken, revokeLease } from "../control/leases.ts";
import {
	type JobAction,
	makeRunnerAuthorizer,
	type RunnerActor,
	type RunnerAuthorizer,
} from "../control/rights.ts";
import type { RunnerStore } from "../control/store.ts";
import { recordWorkerHeartbeat } from "../control/worker-heartbeat.ts";
import { openDurableJob } from "../durable/job.ts";
import {
	type CredentialManager,
	type CredentialManagerDeps,
	createCredentialManager,
} from "./credentials.ts";
import {
	createDesktopDockerExecutor,
	type DesktopContainer,
	type DesktopExecutorDeps,
	resolvedPolicyDigest,
} from "./docker-executor.ts";
import { canonicalSeedDigest, scanSeedDir } from "./seed.ts";

/** The pi-durable runtime the durable job rides (job.ts Runtime mirror). */
type LeafRuntime = Pick<
	HarnessOptions,
	"models" | "registry" | "env" | "settings" | "onReport"
>;
type LeafModels = LeafRuntime extends { models: infer M }
	? Exclude<M, () => unknown>
	: never;

interface HeartbeatEntry {
	timer: ReturnType<typeof setInterval>;
	token: LeaseToken;
}

type DurableJob = Awaited<ReturnType<typeof openDurableJob>>;

type AuthorizeFn = (
	action: JobAction,
	input: { runId: string },
) => Promise<void>;

/** Wire shape of the sandbox tool's args (schema law — parsed in execute;
 *  the JSON-schema `parameters` block mirrors it for the model). */
const SandboxToolArgsSchema = z.strictObject({
	argv: z.array(z.string()).min(1),
	stdin: z.string().optional(),
	timeoutMs: z.number().int().min(1).max(120_000).optional(),
});

/** The sandbox tool the model calls to execute argv commands inside the
 *  run's container — argv arrays only, stdin payload bytes, bounded time
 *  and output. The container holds no keys and has no network; the
 *  execution guard + this tool's own fence both check the lease. */
const containerToolOf = (deps: {
	executor: DesktopContainer;
	runId: string;
	authorize: AuthorizeFn;
}) =>
	defineTool({
		name: "desktop_sandbox_exec",
		description:
			"Run an argv-only command inside this run's sandbox container. Argv arrays only — no shell; stdin via `stdin`; time and output are bounded. No network, no keys.",
		parameters: {
			type: "object",
			properties: {
				argv: { type: "array", items: { type: "string" }, minItems: 1 },
				stdin: { type: "string" },
				timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
			},
			required: ["argv"],
		},
		outputLimits: { maxBytes: 65536, retain: "head" },
		async execute(args, api, context) {
			void api;
			await deps.authorize("execute", { runId: deps.runId });
			// pi-durable hands execute() untyped args — parse against the
			// declared parameters (schema law: wire-facing shape via zod).
			const parsed = SandboxToolArgsSchema.parse(args);
			const out = await deps.executor.dispatchTool(deps.runId, parsed.argv, {
				stdin: parsed.stdin,
				timeoutMs: parsed.timeoutMs,
				signal: context.abortSignal,
			});
			return {
				output: [
					{
						type: "text",
						text: JSON.stringify({
							code: out.code,
							stdout: out.stdout,
							stderr: out.stderr,
						}),
					},
				],
			};
		},
	});

/** The authorizer the durable job rides: EVERY action inside the adapter
 *  fences the executor's CURRENT captured lease token. Control actions
 *  from lanes/humans never pass through here; they ride controller
 *  methods with their own scopes. */

type ExecutionAuthority = ReturnType<typeof captureExecutionAuthority>;

export interface DesktopLeafDeps {
	store: RunnerStore;
	/** Conversation journal root — workspaces/<runId>/state. */
	durableRoot: string;
	/** pi-durable runtime (models/registry/env/settings/onReport). */
	runtime: LeafRuntime;
	container: DesktopExecutorDeps;
	credentials: CredentialManagerDeps;
	/** The executor lane's sid — heartbeats and fences ride it. */
	executorSid: string;
	/** Host actor for admit/stop (runner control scopes). */
	hostActor?: RunnerActor;
	authorizer?: RunnerAuthorizer;
	leaseTtlMs?: number;
	cleanupTimeoutMs?: number;
}

/** The leaf face the host service composes. */
export interface DesktopLeaf {
	controller: RunnerController;
	executor: DesktopContainer;
	credentials: CredentialManager;
	/** The policy digest the executor recomputes at start — spec builders
	 *  MUST stamp this (or start refuses). */
	policyDigest(): string;
	/** Admit + mint + heartbeat + watchdog, abort-observing (#117979): on
	 *  any throw the just-minted key revokes and the lease releases. */
	admitAndStart(input: {
		spec: RunnerSpec;
		actor: RunnerActor;
		seedRoot: string;
	}): Promise<{ token: LeaseToken }>;

	/** Restart reattach (#117942): for every control row in `running`,
	 *  verify the container (workspace-lost refuses), reopen the durable
	 *  journal, re-arm heartbeat + watchdog. */
	recover(): Promise<{
		reattached: string[];
		refused: { runId: string; reason: string }[];
	}>;
	/** Stop one run: stopWithRevocation (fence-first credential revoke →
	 *  bounded independent cleanup). Requires an actor with abort rights
	 *  or the host actor. */
	stopRun(runId: string, actor?: RunnerActor): Promise<unknown>;
	/** Close every live run: durable job closed, container stopped,
	 *  credential revoked, lease revoked, heartbeat + watchdog down. */
	close(): Promise<void>;
}

/** The leaf factory: compose the desktop carrier + credentials + the
 *  W2869.1 durable job + W2869.2 controller into one servable leaf. */
export const createDesktopRunnerLeaf = (deps: DesktopLeafDeps): DesktopLeaf => {
	const ttlMs = deps.leaseTtlMs ?? 60_000;
	const heartbeatIntervalMs = Math.max(1_000, Math.floor(ttlMs / 3));
	const defaultExecutor = createDesktopDockerExecutor(deps.container);
	const executions = new Map<string, OwnedExecution>();
	const generations = new Map<string, OwnedExecution>();
	const handoffs = openHandoffState(deps.store);
	const authorizer =
		deps.authorizer ?? makeRunnerAuthorizer({ store: deps.store });
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const pendingActions = new Set<Promise<unknown>>();
	const trackAction = <T>(run: () => Promise<T>): Promise<T> => {
		const pending = run();
		pendingActions.add(pending);
		void pending.finally(() => pendingActions.delete(pending)).catch(() => {});
		return pending;
	};
	const executorOf = (runId: string) =>
		executions.get(runId)?.executor ?? defaultExecutor;
	const executor: DesktopContainer = {
		start: (spec, opts) => executorOf(spec.runId).start(spec, opts),
		restore: (spec, opts) => executorOf(spec.runId).restore(spec, opts),
		stop: (runId) => executorOf(runId).stop(runId),
		ensureRunning: (runId) => executorOf(runId).ensureRunning(runId),
		quiesce: (runId) => executorOf(runId).quiesce(runId),
		reattach: (runId) => executorOf(runId).reattach(runId),
		dispatchTool: (runId, argv, opts) => {
			handoffs.fence(runId, executions.get(runId)?.epoch ?? 0);
			return executorOf(runId).dispatchTool(runId, argv, opts);
		},
		copyOutArtifacts: (runId, dest) => {
			handoffs.fence(runId, executions.get(runId)?.epoch ?? 0);
			return executorOf(runId).copyOutArtifacts(runId, dest);
		},
		runRecord: (runId) => executorOf(runId).runRecord(runId),
	};
	const credentials = createCredentialManager(deps.credentials);
	const tokens = new Map<string, LeaseToken>();
	const jobs = new Map<string, DurableJob>();
	const heartbeats = new Map<string, HeartbeatEntry>();
	const watchdogs = new Map<string, { stop(): void }>();
	let controller: RunnerController;
	const authorityFor = (
		runId: string,
		token = tokens.get(runId),
		operationId?: string,
	): ExecutionAuthority => {
		if (!token) throw new Error(`runner: no captured lease token for ${runId}`);
		const epoch = token.epoch;
		return captureExecutionAuthority({
			runId,
			executorSid: deps.executorSid,
			token: { epoch },
			credentials,
			fence: (input) => {
				handoffs.fence(runId, epoch, operationId, input.action);
				return authorizer.authorize("execute", input);
			},
		});
	};

	const stopHeartbeat = (runId: string, expected?: HeartbeatEntry): void => {
		const entry = heartbeats.get(runId);
		if (expected && entry !== expected) return;
		if (entry) {
			clearInterval(entry.timer);
			heartbeats.delete(runId);
		}
	};

	const startHeartbeat = (runId: string, suppliedToken: LeaseToken): void => {
		const token = { epoch: suppliedToken.epoch };
		const lease = getLease(deps.store, runId);
		if (lease?.state !== "active" || lease.epoch !== token.epoch) return;
		const identity = {
			runId,
			epoch: token.epoch,
			controllerSid: lease.controller_sid,
		};
		const publish = () => {
			const at = Date.now();
			recordWorkerHeartbeat(
				deps.store,
				identity,
				{ state: "running" },
				at,
				at - ttlMs,
			);
		};
		const entry: HeartbeatEntry = {
			// The heartbeat fences the CAPTURED token — never a fresh lookup;
			// after revoke/takeover the fence fails and the heartbeat stops
			// itself (the watchdog owns the halt ladder, root #117935).
			timer: setInterval(() => {
				const op = handoffs.read(runId);
				if (op?.op_id && op.expires_at <= Date.now()) {
					stopHeartbeat(runId, entry);
					return;
				}
				void controller
					.fence({
						runId,
						actor: { sid: deps.executorSid, scopes: [], leaseToken: token },
					})
					.then(publish)
					.catch(() => stopHeartbeat(runId, entry));
			}, heartbeatIntervalMs),
			token,
		};
		entry.timer.unref();
		heartbeats.set(runId, entry);
	};

	const admitAndStartRaw = async (input: {
		spec: RunnerSpec;
		actor: RunnerActor;
		seedRoot: string;
		autoPark?: boolean;
	}) => {
		const runId = input.spec.runId;
		const files = await scanSeedDir(input.seedRoot);
		const digest = canonicalSeedDigest(files);
		if (digest !== input.spec.seedDigest) {
			throw new Error(
				`desktop-runner: seed drift at admit — seed root ${input.seedRoot} digests to ${digest}, spec binds ${input.spec.seedDigest} — a newer seed is a newer runId`,
			);
		}
		const lease = await controller.admit({
			spec: input.spec,
			actor: { ...input.actor, leaseToken: tokens.get(runId) },
			autoPark: input.autoPark,
		});
		try {
			// Mint keyed by the LEASE epoch (revocation rides the lease
			// generation, not the immutable spec generation).
			await credentials.ensure(runId, lease.token.epoch);
			await controller.fence({
				runId,
				actor: { sid: deps.executorSid, scopes: [], leaseToken: lease.token },
			});
		} catch (err) {
			const current = getLease(deps.store, runId);
			if (current?.epoch === lease.token.epoch && current.state === "active")
				revokeLease(deps.store, runId, Date.now());
			if (
				credentials
					.list()
					.some(
						(receipt) =>
							receipt.runId === runId &&
							receipt.epoch === lease.token.epoch &&
							receipt.revokedAt === null,
					)
			)
				await credentials.revoke(runId, lease.token.epoch);
			throw err;
		}
		tokens.set(runId, lease.token);
		stopHeartbeat(runId);
		watchdogs.get(runId)?.stop();
		startHeartbeat(runId, lease.token);
		watchdogs.set(
			runId,
			controller.watch({ runId, intervalMs: heartbeatIntervalMs }),
		);
		return { token: lease.token };
	};

	const adapter: DurableAdapter = {
		async start(spec, opts) {
			if (executions.has(spec.runId))
				throw new Error(
					"runner: existing owned execution requires explicit cleanup",
				);
			const token = tokens.get(spec.runId);
			if (!token) throw new Error("runner: missing execution token");
			const authority = authorityFor(spec.runId, token);
			const operationId = handoffs.read(spec.runId)?.op_id;
			if (!operationId)
				throw new Error("runner: owned start operation required");
			const ownedExecutor = createDesktopDockerExecutor(deps.container);
			const execution: OwnedExecution = {
				epoch: token.epoch,
				executor: ownedExecutor,
			};
			executions.set(spec.runId, execution);
			generations.set(`${spec.runId}:${token.epoch}`, execution);
			await ownedExecutor.start(spec, opts);
			let job: DurableJob | undefined;
			try {
				job = await openDurableJob({
					root: deps.durableRoot,
					spec,
					runtime: mkRuntime(spec.runId, authority, ownedExecutor),
					authorize: authority.authorize,
				});
				handoffs.pinJournal(spec.runId, operationId, job.journalIdentity);
			} catch (err) {
				const errors: unknown[] = [err];
				try {
					await job?.close();
				} catch (failure) {
					errors.push(failure);
				}
				try {
					await ownedExecutor.stop(spec.runId);
				} catch (failure) {
					errors.push(failure);
				}
				throw new AggregateError(
					errors,
					"runner: start journal preparation failed",
				);
			}
			jobs.set(spec.runId, job);
			execution.job = job;
		},

		async submit(runId, text, opts) {
			const job = jobs.get(runId);
			if (!job) {
				throw new Error(`desktop-runner: no live durable job for ${runId}`);
			}
			// Root #118412: HTTP replay dedupe rides the caller's requestId —
			// the adapter passes it through to the durable submission dedupe;
			// only a caller-supplied requestId is idempotent-replay-safe.
			await job.submit({ requestId: opts?.requestId ?? randomUUID(), text });
		},
		async resume(runId) {
			const job = jobs.get(runId);
			if (!job)
				throw new Error(`desktop-runner: no live durable job for ${runId}`);
			await job.resume();
		},
		async stop(runId, ownership) {
			const execution = ownership
				? generations.get(`${runId}:${ownership.epoch}`)
				: executions.get(runId);
			if (!execution) return;
			const job = execution.job;
			if (jobs.get(runId) === job) jobs.delete(runId);
			try {
				// Control has already fenced the lease. Close the local harness
				// without trying the model-facing, lease-checked abort action.
				await job?.close();
			} finally {
				await execution.executor.stop(runId);
			}
		},
	};

	/** Per-run Models facade — model transport is LEAF-OWNED (root #118378):
	 *  every request method pi-durable's harness calls (streamSimple /
	 *  completeSimple / fetchDeferred / cancelDeferred) rides transformHeaders,
	 *  applied AFTER auth assembly, so overriding `authorization` wins. A
	 *  missing credential throws LOUD — never a silent ambient-key fallback. */
	const modelsFor = (authority: ExecutionAuthority): LeafModels => {
		const supplied = deps.runtime.models;
		// HarnessOptions accepts a Models factory; resolve once for this opened
		// job so its prototype and captured authority stay stable across requests.
		const base = typeof supplied === "function" ? supplied() : supplied;
		const withLeafAuth = (options: object | undefined) => ({
			...options,
			transformHeaders: authority.transformHeaders,
		});
		// Object.create PRESERVES the base Models prototype chain — pi-durable's
		// generation task calls models.getAuth.bind(...) — a PROTOTYPE method on
		// pi-ai's ModelsImpl; a {...base} spread drops it and the run faults
		// before any model call (live-hub diag 2026-11-09).
		const facade = Object.create(base) as LeafModels;
		facade.streamSimple = (model, context, options) =>
			base.streamSimple(model, context, withLeafAuth(options));
		facade.completeSimple = (model, context, options) =>
			base.completeSimple(model, context, withLeafAuth(options));
		facade.fetchDeferred = (model, handle, options) =>
			base.fetchDeferred(model, handle, withLeafAuth(options));
		facade.cancelDeferred = (model, handle, options) =>
			base.cancelDeferred(model, handle, withLeafAuth(options));
		return facade;
	};

	const mkRuntime = (
		runId: string,
		authority: ExecutionAuthority,
		ownedExecutor: DesktopContainer,
	): LeafRuntime => {
		const authorize = authority.authorize;
		const registry = createRegistry();
		// Copy the caller's installed extensions, then add the sandbox tool
		// extension — its name differs from the guard's reserved name
		// (execution-guard refuses a second "fleet-execution-guard").
		for (const ext of deps.runtime.registry.snapshot().installed()) {
			registry.install(ext);
		}
		registry.install(
			defineExtension({
				name: "fleet-desktop-sandbox",
				tools: [containerToolOf({ executor: ownedExecutor, runId, authorize })],
			}),
		);
		return { ...deps.runtime, registry, models: modelsFor(authority) };
	};

	controller = openRunnerController({
		store: deps.store,
		durable: adapter,
		revokeCredential: (runId, { epoch }) => credentials.revoke(runId, epoch),
		authorizer,
		operationActive: (runId) => {
			const op = handoffs.read(runId);
			return Boolean(op?.op_id && op.expires_at > Date.now());
		},
		leaseTtlMs: ttlMs,
		// Docker's graceful stop can use ten seconds before the hard kill.
		cleanupTimeoutMs: deps.cleanupTimeoutMs,
		executorStopTimeoutMs: deps.cleanupTimeoutMs ?? 15_000,
	});

	const stopTimers = (runId: string) => {
		stopHeartbeat(runId);
		watchdogs.get(runId)?.stop();
		watchdogs.delete(runId);
	};
	const arm = (runId: string, token: LeaseToken) => {
		tokens.set(runId, { epoch: token.epoch });
		startHeartbeat(runId, { epoch: token.epoch });
		watchdogs.set(
			runId,
			controller.watch({ runId, intervalMs: heartbeatIntervalMs }),
		);
	};
	const handoff = createLeafHandoff({
		store: deps.store,
		durableRoot: deps.durableRoot,
		container: deps.container,
		credentials,
		handoffs,
		executorSid: deps.executorSid,
		ttlMs,
		execution: (runId) => executions.get(runId),
		fresh: () => createDesktopDockerExecutor(deps.container),
		open: (spec, token, op, ownedExecutor) => {
			const authority = authorityFor(spec.runId, token, op.id);
			return openDurableJob({
				existingOnly: true,
				expectedJournal: handoffs.journal(spec.runId),
				root: deps.durableRoot,
				spec,
				runtime: mkRuntime(spec.runId, authority, ownedExecutor),
				authorize: authority.authorize,
			});
		},
		install: (runId, execution) => {
			executions.set(runId, execution);
			generations.set(`${runId}:${execution.epoch}`, execution);
			if (execution.job) jobs.set(runId, execution.job);
			tokens.set(runId, { epoch: execution.epoch });
		},
		detach: (runId) => {
			jobs.delete(runId);
		},
		stopTimers,
		arm,
	});

	const recover = (): Promise<{
		reattached: string[];
		refused: { runId: string; reason: string }[];
	}> =>
		trackAction(async () => {
			if (closing) throw new Error("runner: HOST closing");
			const reattached: string[] = [],
				refused: { runId: string; reason: string }[] = [];
			const rows = deps.store.all<{ run_id: string }>(
				"SELECT run_id FROM runner_jobs WHERE state = 'running'",
			);
			for (const { run_id: runId } of rows) {
				const lease = getLease(deps.store, runId);
				if (lease?.state !== "active") {
					refused.push({
						runId,
						reason: "no active lease — run cannot reattach",
					});
					continue;
				}
				let op: ReturnType<typeof handoffs.claim> | undefined;
				let job: DurableJob | undefined;
				let guestTouched = false;
				const ownedExecutor = createDesktopDockerExecutor(deps.container);
				try {
					const previous = handoffs.read(runId);
					if (previous && previous.phase !== "live")
						throw new Error("runner: pending handoff cannot reattach");
					op = handoffs.claim(runId, "recovering", lease.epoch);
					const spec = RunnerSpecSchema.parse(
						JSON.parse(
							deps.store.get<{ spec_json: string }>(
								"SELECT spec_json FROM runner_jobs WHERE run_id = ?",
								runId,
							)?.spec_json ?? "",
						),
					);
					const authority = authorityFor(runId, { epoch: lease.epoch }, op.id);
					// Acquire the exclusive HOST writer before any guest or key mutation.
					job = await openDurableJob({
						existingOnly: true,
						expectedJournal: handoffs.journal(runId),
						root: deps.durableRoot,
						spec,
						runtime: mkRuntime(runId, authority, ownedExecutor),
						authorize: authority.authorize,
					});
					await authorizer.authorize("execute", {
						runId,
						actor: {
							sid: deps.executorSid,
							scopes: [],
							leaseToken: { epoch: lease.epoch },
						},
					});
					guestTouched = true;
					await ownedExecutor.reattach(runId);
					await credentials.ensure(runId, lease.epoch);
					await authority.authorize("execute", { runId });
					const execution = {
						epoch: lease.epoch,
						executor: ownedExecutor,
						job,
					};
					executions.set(runId, execution);
					generations.set(`${runId}:${lease.epoch}`, execution);
					jobs.set(runId, job);
					handoffs.finish(op, "live", lease.epoch);
					arm(runId, { epoch: lease.epoch });
					reattached.push(runId);
				} catch (error) {
					const errors: unknown[] = [error];
					try {
						await job?.close();
					} catch (failure) {
						errors.push(failure);
					}
					const current = getLease(deps.store, runId);
					const own =
						current?.state === "active" && current.epoch === lease.epoch;
					if (guestTouched && own) {
						for (const step of [
							() => ownedExecutor.stop(runId),
							() => credentials.revoke(runId, lease.epoch),
						]) {
							try {
								await step();
							} catch (failure) {
								errors.push(failure);
							}
						}
						revokeLease(deps.store, runId, Date.now());
						deps.store.run(
							"UPDATE runner_jobs SET state = 'failed' WHERE run_id = ?",
							runId,
						);
					}
					if (op)
						handoffs.finish(op, guestTouched ? "failed" : "live", lease.epoch);
					refused.push({
						runId,
						reason: errors
							.map((failure) =>
								failure instanceof Error ? failure.message : String(failure),
							)
							.join("; "),
					});
				}
			}
			return { reattached, refused };
		});

	const controlled = <T>(
		runId: string,
		phase: "admitting" | "submitting" | "stopping",
		action: JobAction,
		actor: RunnerActor,
		run: () => Promise<T>,
	): Promise<T> =>
		trackAction(async () => {
			if (closing) throw new Error("runner: HOST closing");
			await authorizer.authorize(action, { runId, actor });
			if (closing) throw new Error("runner: HOST closing");
			const previous = handoffs.read(runId);
			const bound = deps.store.get<{ state: string }>(
				"SELECT state FROM runner_jobs WHERE run_id = ?",
				runId,
			);
			if (
				phase === "admitting" &&
				bound &&
				bound.state !== "cold" &&
				!tokens.has(runId)
			)
				throw new Error(
					"runner: existing execution requires explicit recovery or resume",
				);
			if (phase === "admitting" && previous?.phase === "parked")
				throw new Error("runner: parked run requires explicit resume");
			const op = handoffs.claim(
				runId,
				phase,
				getLease(deps.store, runId)?.epoch ?? 0,
			);
			try {
				return await run();
			} finally {
				const epoch = getLease(deps.store, runId)?.epoch ?? 0;
				handoffs.finish(
					op,
					previous?.phase === "parked"
						? "parked"
						: previous?.phase === "failed"
							? "failed"
							: "live",
					epoch,
				);
			}
		});
	const admitAndStart: DesktopLeaf["admitAndStart"] = (input) =>
		controlled(input.spec.runId, "admitting", "open", input.actor, () =>
			admitAndStartRaw(input),
		);
	const parkOwned = async (runId: string, token: LeaseToken) => {
		await controller.fence({
			runId,
			actor: {
				sid: deps.executorSid,
				scopes: [],
				leaseToken: { epoch: token.epoch },
			},
		});
		await handoff.park(runId, { epoch: token.epoch });
	};
	const publicController: RunnerController = {
		...controller,
		admit: (input) =>
			controlled(input.spec.runId, "admitting", "open", input.actor, () =>
				admitAndStartRaw({ ...input, seedRoot: deps.container.seedRoot }),
			),
		submit: (input) =>
			controlled(input.runId, "submitting", "submit", input.actor, () =>
				controller.submit(input),
			),
		abort: (input) =>
			controlled(input.runId, "stopping", "abort", input.actor, () =>
				controller.abort(input),
			),
		stopWithRevocation: (input) =>
			trackAction(async () => {
				await authorizer.authorize("abort", input);
				if (
					handoffs.read(input.runId)?.phase === "failed" &&
					executions.has(input.runId)
				) {
					await handoff.retryCleanup(input.runId);
					return { ok: true, state: "failed" } as const;
				}
				return controlled(input.runId, "stopping", "abort", input.actor, () =>
					controller.stopWithRevocation(input),
				);
			}),
		fence: async (input) => {
			handoffs.fence(input.runId, input.actor.leaseToken?.epoch ?? 0);
			await controller.fence(input);
		},
		park: (input) =>
			trackAction(async () => {
				if (closing) throw new Error("runner: HOST closing");
				await authorizer.authorize("abort", input);
				if (closing) throw new Error("runner: HOST closing");
				const execution = executions.get(input.runId);
				if (!execution?.job)
					return { ok: false, reason: "runner: no live workspace to park" };
				await parkOwned(input.runId, { epoch: execution.epoch });
				return { ok: true, state: "parked" } as const;
			}),
		resume: (input) =>
			trackAction(async () => {
				if (closing) throw new Error("runner: HOST closing");
				await authorizer.authorize("resume", input);
				if (closing) throw new Error("runner: HOST closing");
				if (handoffs.read(input.runId)?.phase !== "parked")
					return controlled(
						input.runId,
						"submitting",
						"resume",
						input.actor,
						() => controller.resume(input),
					);
				let result: Awaited<ReturnType<RunnerController["resume"]>> = {
					ok: false,
					reason: "runner: restore did not activate",
				};
				await handoff.restore(input.runId, async () => {
					result = await controller.resume(input);
					if (!result.ok) throw new Error(result.reason);
				});
				return result;
			}),
	};

	const stopRun = (runId: string, actor?: RunnerActor): Promise<unknown> => {
		const resolved = actor ?? deps.hostActor;
		if (!resolved) {
			throw new Error(
				"desktop-runner: stopRun needs an actor with abort rights",
			);
		}
		return publicController.stopWithRevocation({ runId, actor: resolved });
	};

	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		closing = true;
		closePromise = (async () => {
			const joined = await Promise.allSettled([...pendingActions]);
			const errors: unknown[] = joined.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : [],
			);
			for (const [runId, token] of tokens) {
				if (handoffs.read(runId)?.phase === "failed" && executions.has(runId)) {
					try {
						await handoff.retryCleanup(runId);
					} catch (error) {
						errors.push(error);
					}
					continue;
				}
				const lease = getLease(deps.store, runId);
				if (lease?.state !== "active" || lease.epoch !== token.epoch) continue;
				try {
					if (jobs.has(runId)) await parkOwned(runId, { epoch: token.epoch });
					else {
						const op = handoffs.claim(runId, "stopping", token.epoch);
						revokeLease(deps.store, runId, Date.now());
						const failures: unknown[] = [];
						for (const step of [
							() => credentials.revoke(runId, token.epoch),
							() => adapter.stop(runId, { epoch: token.epoch }),
						]) {
							try {
								await step();
							} catch (failure) {
								failures.push(failure);
							}
						}
						deps.store.run(
							"UPDATE runner_jobs SET state = ? WHERE run_id = ?",
							failures.length ? "failed" : "stopped",
							runId,
						);
						handoffs.finish(op, "failed", token.epoch);
						if (failures.length)
							throw new AggregateError(
								failures,
								"runner: cold execution cleanup failed",
							);
					}
				} catch (error) {
					errors.push(error);
				}
			}
			for (const runId of watchdogs.keys()) stopTimers(runId);
			for (const runId of heartbeats.keys()) stopHeartbeat(runId);
			if (errors.length)
				throw new AggregateError(errors, "runner: HOST close failed");
		})();
		return closePromise;
	};

	return {
		controller: publicController,
		executor,
		credentials,
		policyDigest: () => resolvedPolicyDigest(deps.container),
		admitAndStart,
		recover,
		stopRun,
		close,
	};
};
