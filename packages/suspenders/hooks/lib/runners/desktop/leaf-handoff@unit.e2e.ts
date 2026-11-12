import { JobManifestSchema } from "../durable/contracts.ts";
import { Database } from "bun:sqlite";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { openRunnerController } from "../control/controller.ts";
import { openHandoffState } from "../control/handoff-state.ts";
import { getLease } from "../control/leases.ts";
import { sqliteStore } from "../control/store.ts";
import { RunnerSpecSchema } from "../control/control-state.ts";
import { RUNNER_SCOPES } from "../control/rights.ts";
import { createLeafHandoff, type OwnedExecution } from "./leaf-handoff.ts";
import type { DesktopContainer, ExecutorRecord } from "./docker-executor.ts";
import type { CredentialManager } from "./credentials.ts";
import type { openDurableJob } from "../durable/job.ts";

test("final patch request cannot silently park without producing its bound patch @unit", async () => {
	const f = await fixture();
	try {
		const archivePath = join(f.world.home, "base.tar");
		await writeFile(archivePath, new Uint8Array(1024), { mode: 0o600 });
		await expect(
			f.handoff.park(
				f.spec.runId,
				{ epoch: 1 },
				{
					base: { commit: "a".repeat(40), archivePath, sha256: "f".repeat(64) },
					repositoryPath: "src",
					helperImage: f.record.image,
					outputRoot: f.world.home,
					maxBytes: 4096,
				},
			),
		).rejects.toThrow("park failed");
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("failed");
		expect(f.stats().stoppedCids).toEqual([f.record.containerId]);
	} finally {
		f.clean();
	}
});

async function fixture() {
	const world = scratchWorld(),
		db = new Database(":memory:"),
		store = sqliteStore(db);
	const controller = openRunnerController({ store }),
		handoffs = openHandoffState(store);
	const spec = RunnerSpecSchema.parse({
		version: 1,
		runId: crypto.randomUUID(),
		generation: 1,
		owner: "fixture",
		kind: "coding",
		provider: "fixture",
		model: "fixture",
		seedDigest: "a".repeat(64),
		policyDigest: "b".repeat(64),
	});
	await controller.admit({
		spec,
		actor: { sid: "executor", scopes: [RUNNER_SCOPES.control] },
	});
	store.run(
		"UPDATE runner_jobs SET state = 'running' WHERE run_id = ?",
		spec.runId,
	);
	const manifest = JobManifestSchema.parse({
		spec,
		host: hostname(),
		runtime: "pi-durable@1.5.0",
	});
	const directory = join(world.home, spec.runId),
		state = join(directory, "state");
	await mkdir(state, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), {
		mode: 0o600,
	});
	await writeFile(join(state, "main.jsonl"), "original conversation\n", {
		mode: 0o600,
	});
	const record: ExecutorRecord = {
		runId: spec.runId,
		containerName: "fixture",
		containerId: "c".repeat(64),
		image: `fixture/tool@sha256:${"d".repeat(64)}`,
		seedDir: "fixture",
		argv: [],
		expired: false,
		executed: true,
		startedAt: Date.now(),
		deadlineAt: Date.now() + 120_000,
	};
	const stoppedCids: string[] = [];
	let allocated = 0,
		stopped = 0,
		minted = 0,
		opened = 0,
		stopFails = false,
		restoreFails = false,
		tarExit = 0;
	let revoke: () => Promise<void> = async () => {};
	const executor: DesktopContainer = {
		start: async () => {},
		ensureRunning: async () => record,
		reattach: async () => record,
		quiesce: async () => record,
		runRecord: () => record,
		dispatchTool: async () => ({ code: 0, stdout: "", stderr: "" }),
		copyOutArtifacts: async () => ({ files: 0, bytes: 0 }),
		restore: async () => {
			allocated++;
			if (restoreFails) throw new Error("restore save failed");
		},
		stop: async () => {
			stopped++;
			stoppedCids.push(record.containerId);
			if (stopFails) throw new Error("stop refused");
		},
	};
	const freshRecord = { ...record, containerId: "f".repeat(64) };
	const freshExecutor: DesktopContainer = {
		...executor,
		runRecord: () => freshRecord,
		stop: async () => {
			stopped++;
			stoppedCids.push(freshRecord.containerId);
			if (stopFails) throw new Error("stop refused");
		},
	};
	const job = { manifest, conversationId: 1, close: async () => {} } as Awaited<
		ReturnType<typeof openDurableJob>
	>;
	let execution: OwnedExecution = { epoch: 1, executor, job };
	const credentials: CredentialManager = {
		mint: async () => {
			throw new Error("not used");
		},
		ensure: async (_runId, epoch) => {
			minted++;
			return { key: "fixture", keyId: "key", epoch };
		},
		revoke: async () => revoke(),
		list: () => [],
		resolve: () => undefined,
	};
	const handoff = createLeafHandoff({
		store,
		durableRoot: world.home,
		container: {
			image: record.image,
			seedRoot: world.home,
			workspacesDir: world.home,
			dockerArgv: () => [
				"bun",
				"-e",
				"for await (const chunk of Bun.stdin.stream()) void chunk",
			],
			runDockerStream: async () => ({
				stream: new ReadableStream({
					start(output) {
						output.enqueue(new Uint8Array(1024));
						output.close();
					},
				}),
				exit: Promise.resolve(tarExit),
				kill: () => {},
				stderr: async () => "",
			}),
		},
		credentials,
		handoffs,
		executorSid: "executor",
		ttlMs: 60_000,
		execution: () => execution,
		fresh: () => freshExecutor,
		open: async () => {
			opened++;
			return job;
		},
		install: (_runId, value) => {
			execution = value;
		},
		detach: () => {
			execution.job = undefined;
		},
		stopTimers: () => {},
		arm: () => {},
	});
	return {
		world,
		db,
		store,
		spec,
		record,
		handoffs,
		handoff,
		state,
		directory,
		stats: () => ({
			allocated,
			stopped,
			minted,
			opened,
			stoppedCids: [...stoppedCids],
		}),
		execution: () => execution,
		setRevoke: (fn: () => Promise<void>) => {
			revoke = fn;
		},
		setStopFails: (value: boolean) => {
			stopFails = value;
		},
		setRestoreFails: () => {
			restoreFails = true;
		},
		setTarExit: () => {
			tarExit = 7;
		},
		clean: () => {
			db.close();
			world.clean();
		},
	};
}

test("park waits for old key death and keeps concurrent operations excluded @unit", async () => {
	const f = await fixture();
	let release = () => {},
		entered = false;
	f.setRevoke(() => {
		entered = true;
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	});
	try {
		const parking = f.handoff.park(f.spec.runId, { epoch: 1 });
		await expect.poll(() => entered).toBe(true);
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("parking");
		expect(f.handoffs.read(f.spec.runId)?.checkpoint_json).toBeNull();
		expect(() => f.handoffs.claim(f.spec.runId, "submitting", 1)).toThrow(
			"in progress",
		);
		expect(f.stats().minted).toBe(0);
		release();
		await parking;
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("parked");
		expect(getLease(f.store, f.spec.runId)?.state).toBe("revoked");
	} finally {
		release();
		f.clean();
	}
});

test("valid stdout followed by nonzero tar cannot publish resumable state @unit", async () => {
	const f = await fixture();
	f.setTarExit();
	try {
		await expect(f.handoff.park(f.spec.runId, { epoch: 1 })).rejects.toThrow(
			"park failed",
		);
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("failed");
		expect(f.handoffs.read(f.spec.runId)?.checkpoint_json).toBeNull();
		expect(f.stats().stopped).toBeGreaterThan(0);
	} finally {
		f.clean();
	}
});

test("old key revocation failure prevents PARKED and fresh key mint @unit", async () => {
	const f = await fixture();
	f.setRevoke(async () => {
		throw new Error("admin refused");
	});
	try {
		await expect(f.handoff.park(f.spec.runId, { epoch: 1 })).rejects.toThrow(
			"park failed",
		);
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("failed");
		expect(f.stats().minted).toBe(0);
		expect(f.stats().stopped).toBeGreaterThan(0);
	} finally {
		f.clean();
	}
});

for (const damage of ["missing", "empty", "changed", "manifest"] as const)
	test(`restore refuses ${damage} HOST history before guest or mint @unit`, async () => {
		const f = await fixture();
		try {
			await f.handoff.park(f.spec.runId, { epoch: 1 });
			if (damage === "missing") await rm(f.state, { recursive: true });
			else if (damage === "manifest")
				await rm(join(f.directory, "manifest.json"));
			else
				await writeFile(
					join(f.state, "main.jsonl"),
					damage === "empty" ? "" : "replacement history\n",
				);
			await expect(
				f.handoff.restore(f.spec.runId, async () => {}),
			).rejects.toThrow("restore refused");
			expect(f.stats().allocated).toBe(0);
			expect(f.stats().minted).toBe(0);
			expect(f.stats().opened).toBe(0);
		} finally {
			f.clean();
		}
	});

for (const damage of [
	"corrupt",
	"missing",
	"oversize",
	"expired",
	"image",
] as const)
	test(`restore refuses ${damage} checkpoint before allocation @unit`, async () => {
		const f = await fixture();
		try {
			await f.handoff.park(f.spec.runId, { epoch: 1 });
			const raw = f.handoffs.read(f.spec.runId)?.checkpoint_json;
			if (!raw) throw new Error("fixture receipt missing");
			const receipt = JSON.parse(raw);
			const archive = join(
				f.world.home,
				".checkpoints",
				receipt.checkpoint.id,
				"workspace.tar",
			);
			if (damage === "missing") await rm(archive);
			else if (damage === "corrupt") await writeFile(archive, "not tar");
			else if (damage === "oversize")
				await writeFile(archive, new Uint8Array(33 * 1024 * 1024));
			else {
				if (damage === "expired") receipt.checkpoint.binding.deadlineAt = 1;
				else
					receipt.checkpoint.binding.image = `other/tool@sha256:${"e".repeat(64)}`;
				f.store.run(
					"UPDATE runner_handoffs SET checkpoint_json = ? WHERE run_id = ?",
					JSON.stringify(receipt),
					f.spec.runId,
				);
			}
			await expect(
				f.handoff.restore(f.spec.runId, async () => {}),
			).rejects.toThrow("restore refused");
			expect(f.stats().allocated).toBe(0);
			expect(f.stats().minted).toBe(0);
		} finally {
			f.clean();
		}
	});

test("restore failure retains exact executor identity for checked stop retry @unit", async () => {
	const f = await fixture();
	try {
		await f.handoff.park(f.spec.runId, { epoch: 1 });
		f.setRestoreFails();
		f.setStopFails(true);
		await expect(
			f.handoff.restore(f.spec.runId, async () => {}),
		).rejects.toThrow("restore refused");
		const execution = f.execution();
		expect(execution.epoch).toBeGreaterThan(1);
		expect(execution.executor.runRecord(f.spec.runId)?.containerId).toBe(
			"f".repeat(64),
		);
		expect(f.stats().stoppedCids.at(-1)).toBe("f".repeat(64));
		const before = f.stats().stopped;
		f.setStopFails(false);
		await f.handoff.retryCleanup(f.spec.runId);
		expect(f.stats().stopped).toBe(before + 1);
		expect(f.stats().stoppedCids.at(-1)).toBe("f".repeat(64));
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("failed");
		expect(f.stats().minted).toBe(0);
	} finally {
		f.clean();
	}
});

test("restore validates raw tar before invoking trusted binary extraction @unit", async () => {
	const f = await fixture();
	try {
		await f.handoff.park(f.spec.runId, { epoch: 1 });
		const raw = f.handoffs.read(f.spec.runId)?.checkpoint_json;
		expect(raw).toBeTruthy();
		// The positive transport seam consumes binary stdin; actual Docker
		// extraction + marker/conversation continuity is covered by desktop-wiring.
		let activated = false;
		await f.handoff.restore(f.spec.runId, async () => {
			activated = true;
		});
		expect(activated).toBe(true);
		expect(f.stats().allocated).toBe(1);
		expect(f.stats().minted).toBe(1);
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("live");
	} finally {
		f.clean();
	}
});

test("restore waits for old key revalidation before new admission and mint @unit", async () => {
	const f = await fixture();
	let release = () => {},
		entered = false;
	try {
		await f.handoff.park(f.spec.runId, { epoch: 1 });
		const oldEpoch = getLease(f.store, f.spec.runId)?.epoch;
		f.setRevoke(() => {
			entered = true;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		});
		const restoring = f.handoff.restore(f.spec.runId, async () => {});
		await expect.poll(() => entered).toBe(true);
		expect(getLease(f.store, f.spec.runId)?.epoch).toBe(oldEpoch);
		expect(f.stats()).toMatchObject({ allocated: 0, minted: 0, opened: 0 });
		expect(() => f.handoffs.claim(f.spec.runId, "stopping", 1)).toThrow(
			"in progress",
		);
		release();
		await restoring;
		expect(getLease(f.store, f.spec.runId)?.epoch).toBeGreaterThan(
			oldEpoch ?? 0,
		);
	} finally {
		release();
		f.clean();
	}
});

test("restore old-key failure refuses without new admission or allocation @unit", async () => {
	const f = await fixture();
	try {
		await f.handoff.park(f.spec.runId, { epoch: 1 });
		const oldEpoch = getLease(f.store, f.spec.runId)?.epoch;
		f.setRevoke(async () => {
			throw new Error("revalidation refused");
		});
		await expect(
			f.handoff.restore(f.spec.runId, async () => {}),
		).rejects.toThrow("restore refused");
		expect(getLease(f.store, f.spec.runId)?.epoch).toBe(oldEpoch);
		expect(f.stats()).toMatchObject({ allocated: 0, minted: 0, opened: 0 });
	} finally {
		f.clean();
	}
});

test("restore persistence failure with successful cleanup stops fresh CID @unit", async () => {
	const f = await fixture();
	try {
		await f.handoff.park(f.spec.runId, { epoch: 1 });
		f.setRestoreFails();
		await expect(
			f.handoff.restore(f.spec.runId, async () => {}),
		).rejects.toThrow("restore refused");
		expect(f.stats().stoppedCids).toEqual(["c".repeat(64), "f".repeat(64)]);
		expect(getLease(f.store, f.spec.runId)?.state).toBe("revoked");
		expect(f.handoffs.read(f.spec.runId)?.phase).toBe("failed");
	} finally {
		f.clean();
	}
});

test("unchanged checkpoint refuses once its original deadline expires @unit", async () => {
	const f = await fixture();
	try {
		f.record.deadlineAt = Date.now() + 100;
		await f.handoff.park(f.spec.runId, { epoch: 1 });
		const receipt = f.handoffs.read(f.spec.runId)?.checkpoint_json;
		await new Promise((resolve) => setTimeout(resolve, 125));
		await expect(
			f.handoff.restore(f.spec.runId, async () => {}),
		).rejects.toThrow("restore refused");
		expect(f.stats()).toMatchObject({ allocated: 0, minted: 0 });
		expect(f.handoffs.read(f.spec.runId)?.checkpoint_json).toBe(receipt);
	} finally {
		f.clean();
	}
});
