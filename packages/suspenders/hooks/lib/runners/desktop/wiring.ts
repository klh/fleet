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
import { z } from "zod";
import {
	createRegistry,
	defineExtension,
	defineTool,
	type HarnessOptions,
} from "@earendil-works/pi-durable";
import { openDurableJob } from "../durable/job.ts";
import {
	type JobAction,
	makeRunnerAuthorizer,
	type RunnerActor,
	type RunnerAuthorizer,
} from "../control/rights.ts";
import {
	openRunnerController,
	type DurableAdapter,
	type RunnerController,
} from "../control/controller.ts";
import { revokeLease, type LeaseToken } from "../control/leases.ts";
import { RunnerSpecSchema, type RunnerSpec } from "../control/control-state.ts";
import type { RunnerStore } from "../control/store.ts";
import { canonicalSeedDigest, scanSeedDir } from "./seed.ts";
import {
	createDesktopDockerExecutor,
	resolvedPolicyDigest,
	type DesktopContainer,
	type DesktopExecutorDeps,
} from "./docker-executor.ts";
import {
	createCredentialManager,
	type CredentialManager,
	type CredentialManagerDeps,
} from "./credentials.ts";

/** The pi-durable runtime the durable job rides (job.ts Runtime mirror). */
type LeafRuntime = Pick<
	HarnessOptions,
	"models" | "registry" | "env" | "settings" | "onReport"
>;

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
			void context;
			await deps.authorize("execute", { runId: deps.runId });
			// pi-durable hands execute() untyped args — parse against the
			// declared parameters (schema law: wire-facing shape via zod).
			const parsed = SandboxToolArgsSchema.parse(args);
			const out = await deps.executor.dispatchTool(deps.runId, parsed.argv, {
				stdin: parsed.stdin,
				timeoutMs: parsed.timeoutMs,
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

const leaseFence =
	(
		getController: () => RunnerController,
		executorSid: string,
		tokens: Map<string, LeaseToken>,
	): AuthorizeFn =>
	async (action, { runId }) => {
		void action;
		const token = tokens.get(runId);
		if (!token) {
			throw new Error(`runner: no captured lease token for ${runId}`);
		}
		await getController().fence({
			runId,
			actor: { sid: executorSid, scopes: [], leaseToken: token },
		});
	};

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
	const executor = createDesktopDockerExecutor(deps.container);
	const credentials = createCredentialManager(deps.credentials);
	const tokens = new Map<string, LeaseToken>();
	const jobs = new Map<string, DurableJob>();
	const heartbeats = new Map<string, HeartbeatEntry>();
	const watchdogs = new Map<string, { stop(): void }>();
	let controller: RunnerController;
	const authorize = leaseFence(() => controller, deps.executorSid, tokens);

	const stopHeartbeat = (runId: string): void => {
		const entry = heartbeats.get(runId);
		if (entry) {
			clearInterval(entry.timer);
			heartbeats.delete(runId);
		}
	};

	const startHeartbeat = (runId: string, token: LeaseToken): void => {
		const entry: HeartbeatEntry = {
			// The heartbeat fences the CAPTURED token — never a fresh lookup;
			// after revoke/takeover the fence fails and the heartbeat stops
			// itself (the watchdog owns the halt ladder, root #117935).
			timer: setInterval(() => {
				void controller
					.fence({
						runId,
						actor: { sid: deps.executorSid, scopes: [], leaseToken: token },
					})
					.catch(() => stopHeartbeat(runId));
			}, heartbeatIntervalMs),
			token,
		};
		entry.timer.unref();
		heartbeats.set(runId, entry);
	};

	const admitAndStart = async (input: {
		spec: RunnerSpec;
		actor: RunnerActor;
		seedRoot: string;
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
			actor: input.actor,
		});
		try {
			// Mint keyed by the LEASE epoch (revocation rides the lease
			// generation, not the immutable spec generation).
			await credentials.mint(runId, lease.token.epoch);
		} catch (err) {
			revokeLease(deps.store, runId, Date.now());
			throw err;
		}
		tokens.set(runId, lease.token);
		startHeartbeat(runId, lease.token);
		watchdogs.set(
			runId,
			controller.watch({ runId, intervalMs: heartbeatIntervalMs }),
		);
		return { token: lease.token };
	};

	const adapter: DurableAdapter = {
		async start(spec, opts) {
			await executor.start(spec, opts);
			let job: DurableJob;
			try {
				job = await openDurableJob({
					root: deps.durableRoot,
					spec,
					runtime: mkRuntime(spec.runId),
					authorize,
				});
			} catch (err) {
				await executor.stop(spec.runId);
				throw err;
			}
			jobs.set(spec.runId, job);
		},

		async submit(runId, text) {
			const job = jobs.get(runId);
			if (!job) {
				throw new Error(`desktop-runner: no live durable job for ${runId}`);
			}
			await job.submit({ requestId: randomUUID(), text });
		},
		async resume(runId) {
			await jobs.get(runId)?.resume();
		},
		async stop(runId) {
			const job = jobs.get(runId);
			jobs.delete(runId);
			if (job) {
				await job.abort();
				await job.close();
			}
			await executor.stop(runId);
		},
	};

	const mkRuntime = (runId: string): LeafRuntime => {
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
				tools: [containerToolOf({ executor, runId, authorize })],
			}),
		);
		return { ...deps.runtime, registry };
	};

	controller = openRunnerController({
		store: deps.store,
		durable: adapter,
		revokeCredential: (runId, { epoch }) => credentials.revoke(runId, epoch),
		authorizer: deps.authorizer ?? makeRunnerAuthorizer({ store: deps.store }),
		leaseTtlMs: ttlMs,
		cleanupTimeoutMs: deps.cleanupTimeoutMs,
	});

	const recover = async (): Promise<{
		reattached: string[];
		refused: { runId: string; reason: string }[];
	}> => {
		const reattached: string[] = [];
		const refused: { runId: string; reason: string }[] = [];
		const rows = deps.store.all<{ run_id: string }>(
			"SELECT run_id FROM runner_jobs WHERE state = 'running'",
		);

		for (const row of rows) {
			const runId = row.run_id;
			const leaseRow = deps.store.get<{
				epoch: number;
				state: string;
			}>("SELECT epoch, state FROM runner_leases WHERE run_id = ?", runId);
			if (leaseRow?.state !== "active") {
				refused.push({
					runId,
					reason: "no active lease — run cannot reattach",
				});
				continue;
			}
			tokens.set(runId, { epoch: leaseRow.epoch });

			try {
				await executor.ensureRunning(runId);
				const spec = RunnerSpecSchema.parse(
					JSON.parse(
						deps.store.get<{ spec_json: string }>(
							"SELECT spec_json FROM runner_jobs WHERE run_id = ?",
							runId,
						)?.spec_json ?? "",
					),
				);
				const job = await openDurableJob({
					root: deps.durableRoot,
					spec,
					runtime: mkRuntime(runId),
					authorize,
				});
				jobs.set(runId, job);
				startHeartbeat(runId, { epoch: leaseRow.epoch });
				watchdogs.set(
					runId,
					controller.watch({ runId, intervalMs: heartbeatIntervalMs }),
				);
				reattached.push(runId);
			} catch (err) {
				tokens.delete(runId);
				refused.push({
					runId,
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return { reattached, refused };
	};

	const stopRun = (runId: string, actor?: RunnerActor): Promise<unknown> => {
		const resolved = actor ?? deps.hostActor;
		if (!resolved) {
			throw new Error(
				"desktop-runner: stopRun needs an actor with abort rights",
			);
		}
		return controller.stopWithRevocation({ runId, actor: resolved });
	};

	const close = async (): Promise<void> => {
		for (const runId of [...jobs.keys()]) {
			try {
				await adapter.stop(runId);
			} catch {
				// Close is best-effort: every run's halt ladder (stopWithRevocation
				// or watchdog) still revokes its credential + lease.
			}
		}
		for (const runId of [...watchdogs.keys()]) {
			watchdogs.get(runId)?.stop();
			watchdogs.delete(runId);
		}
		for (const runId of [...heartbeats.keys()]) {
			stopHeartbeat(runId);
		}
	};

	return {
		controller,
		executor,
		credentials,
		policyDigest: () => resolvedPolicyDigest(deps.container),
		admitAndStart,
		recover,
		stopRun,
		close,
	};
};
