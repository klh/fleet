import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { RunnerSpecSchema } from "../hooks/lib/runners/control/control-state.ts";
import {
	createDesktopDockerExecutor,
	resolvedPolicyDigest,
	type DesktopExecutorDeps,
} from "../hooks/lib/runners/desktop/docker-executor.ts";
import { canonicalSeedDigest } from "../hooks/lib/runners/desktop/seed.ts";

const IMAGE =
	"oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";

for (const phase of ["start", "recover"])
	test(`record persistence failure during ${phase} rolls back the actual Docker guest @unit`, async () => {
		const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
		let containerId = "",
			blockedRecord = "",
			sabotage = phase === "start";
		const run = await liveExecutor(
			{
				runDocker: async (argv, options) => {
					const result = await runArgv(argv, options);
					if (argv[1] === "run" && result.code === 0 && sabotage) {
						containerId = result.stdout.trim();
						expect(containerId).toMatch(/^[a-f0-9]{64}$/);
						const mount = argv.find((arg) => arg.endsWith(":/seed:ro"));
						if (!mount) throw new Error("missing fixture seed mount");
						blockedRecord = join(
							mount.slice(0, -":/seed:ro".length),
							"..",
							"executor.json",
						);
						const { rm } = await import("node:fs/promises");
						await rm(blockedRecord, { force: true });
						await mkdir(blockedRecord);
					}
					return result;
				},
			},
			phase === "recover",
		);
		try {
			if (phase === "recover") {
				const original = run.executor.runRecord(run.runId);
				if (!original) throw new Error("missing initial guest record");
				expect(
					(await runArgv(["docker", "rm", "-f", original.containerId])).code,
				).toBe(0);
				sabotage = true;
			}
			const operation =
				phase === "start"
					? run.executor.start(run.spec, {
							signal: new AbortController().signal,
						})
					: run.executor.ensureRunning(run.runId);
			await expect(operation).rejects.toThrow();
			expect(blockedRecord).not.toBe("");
			await expect
				.poll(
					async () => (await runArgv(["docker", "inspect", containerId])).code,
				)
				.not.toBe(0);
			expect(
				(await runArgv(["docker", "inspect", containerId])).stderr,
			).toMatch(/no such (?:object|container)/i);
			const stopping = await run.executor.stop(run.runId).then(
				() => null,
				(error: unknown) => error,
			);
			if (stopping !== null)
				expect(stopping).toMatchObject({
					message: expect.stringMatching(/cleanup|persist|EISDIR|rename/i),
				});
			expect(
				(await runArgv(["docker", "inspect", containerId])).stderr,
			).toMatch(/no such (?:object|container)/i);
		} finally {
			try {
				if (containerId) {
					const removed = await runArgv(["docker", "rm", "-f", containerId]);
					if (removed.code !== 0)
						expect(removed.stderr).toMatch(/no such (?:object|container)/i);
				}
			} finally {
				const { rm } = await import("node:fs/promises");
				try {
					if (blockedRecord)
						await rm(blockedRecord, { recursive: true, force: true });
				} finally {
					await run.close();
				}
			}
		}
	});

test("an already aborted start cannot create a guest @unit", async () => {
	const run = await liveExecutor({}, false),
		controller = new AbortController();
	controller.abort();
	try {
		await expect(
			run.executor.start(run.spec, { signal: controller.signal }),
		).rejects.toThrow(/abort/i);
		expect(run.executor.runRecord(run.runId)).toBeNull();
	} finally {
		await run.close();
	}
});

for (const phase of ["start", "recover"])
	test(`stop joins an in-flight Docker ${phase} and refuses successful startup @unit`, async () => {
		const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
		const gate = Promise.withResolvers<void>(),
			entered = Promise.withResolvers<void>();
		let hold = phase === "start";
		const run = await liveExecutor(
			{
				runDocker: async (argv, options) => {
					if (argv[1] === "run" && hold) {
						entered.resolve();
						await gate.promise;
					}
					return runArgv(argv, options);
				},
			},
			phase === "recover",
		);
		const owner = phase === "recover" ? run.reopen() : run.executor;
		if (phase === "recover") {
			const record = run.executor.runRecord(run.runId);
			if (!record) throw new Error("missing initial guest");
			expect(
				(await runArgv(["docker", "rm", "-f", record.containerId])).code,
			).toBe(0);
			hold = true;
		}
		const operation =
			phase === "start"
				? owner.start(run.spec, { signal: new AbortController().signal })
				: owner.ensureRunning(run.runId);
		const starting = operation.then(
			() => null,
			(error: unknown) => error,
		);
		let stopping: Promise<unknown> | undefined;
		try {
			await entered.promise;
			let settled = false;
			stopping = owner.stop(run.runId).then(
				() => {
					settled = true;
					return null;
				},
				(error: unknown) => {
					settled = true;
					return error;
				},
			);
			await Bun.sleep(30);
			expect(settled).toBe(false);
			gate.resolve();
			expect(await starting).toMatchObject({
				message: expect.stringMatching(/stopped|closed/),
			});
			expect(await stopping).toBeNull();
			const record = owner.runRecord(run.runId);
			if (!record) throw new Error("missing refused startup record");
			await expect
				.poll(
					async () =>
						(await runArgv(["docker", "inspect", record.containerId])).code,
				)
				.not.toBe(0);
			expect(
				(await runArgv(["docker", "inspect", record.containerId])).stderr,
			).toMatch(/no such (?:object|container)/i);
		} finally {
			gate.resolve();
			await starting;
			await stopping;
			await run.close();
		}
	});

for (const action of ["quiesce", "recover", "reopen", "export"])
	test(`stopped lifecycle refuses ${action} without creating another guest @unit`, async () => {
		const run = await liveExecutor();
		const record = run.executor.runRecord(run.runId);
		if (!record) throw new Error("missing live fixture record");
		try {
			const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
			await run.executor.stop(run.runId);
			await expect
				.poll(
					async () =>
						(await runArgv(["docker", "inspect", record.containerId])).code,
				)
				.not.toBe(0);
			const effect =
				action === "quiesce"
					? run.executor.quiesce(run.runId)
					: action === "recover"
						? run.executor.ensureRunning(run.runId)
						: action === "reopen"
							? run.reopen().ensureRunning(run.runId)
							: run.executor.copyOutArtifacts(
									run.runId,
									join(record.seedDir, "..", "export"),
								);
			await expect(effect).rejects.toThrow(/stopped|closed/);
			const leftover = await runArgv([
				"docker",
				"ps",
				"-a",
				"--filter",
				`name=${record.containerName}`,
				"--format",
				"{{.ID}}",
			]);
			expect(leftover.code).toBe(0);
			expect(leftover.stdout.trim()).toBe("");
		} finally {
			await run.close();
		}
	});

test("a missing guest runtime refuses startup and removes the guest @unit", async () => {
	const run = await liveExecutor(
		{
			image:
				"alpine:latest@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b",
		},
		false,
	);
	try {
		await expect(
			run.executor.start(run.spec, { signal: new AbortController().signal }),
		).rejects.toThrow("prerequisites");
		const record = run.executor.runRecord(run.runId);
		if (!record) throw new Error("missing refused startup record");
		const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
		await expect
			.poll(
				async () =>
					(await runArgv(["docker", "inspect", record.containerId])).code,
			)
			.not.toBe(0);
		expect(
			(await runArgv(["docker", "inspect", record.containerId])).stderr,
		).toMatch(/no such (?:object|container)/i);
	} finally {
		await run.close();
	}
});

async function liveExecutor(
	options: Partial<
		Pick<DesktopExecutorDeps, "processTransportFactory" | "image" | "runDocker">
	> = {},
	autoStart = true,
) {
	const world = scratchWorld(),
		seedRoot = join(world.home, "seed"),
		workspacesDir = join(world.home, "workspaces");
	await mkdir(seedRoot, { mode: 0o700 });
	await mkdir(workspacesDir, { mode: 0o700 });
	const bytes = new TextEncoder().encode("fixture seed\n");
	await writeFile(join(seedRoot, "seed.txt"), bytes);
	const deps = {
		image: IMAGE,
		seedRoot,
		workspacesDir,
		deadlineMs: 30_000,
		stopTimeoutS: 0,
		...options,
	};
	const executor = createDesktopDockerExecutor(deps);
	const spec = RunnerSpecSchema.parse({
		version: 1,
		runId: crypto.randomUUID(),
		owner: "integration-fixture",
		generation: 1,
		kind: "coding",
		seedDigest: canonicalSeedDigest([{ path: "seed.txt", bytes }]),
		policyDigest: resolvedPolicyDigest(deps),
		provider: "fixture",
		model: "fixture",
	});
	try {
		if (autoStart)
			await executor.start(spec, { signal: new AbortController().signal });
	} catch (error) {
		world.clean();
		throw error;
	}
	return {
		executor,
		spec,
		runId: spec.runId,
		reopen: () => createDesktopDockerExecutor(deps),
		async close() {
			try {
				await executor.stop(spec.runId);
			} finally {
				world.clean();
			}
		},
	};
}

test("default executor timeout stops the actual guest writer @unit", async () => {
	const run = await liveExecutor();
	try {
		await expect(
			run.executor.dispatchTool(
				run.runId,
				[
					"/usr/local/bin/bun",
					"-e",
					"setInterval(()=>require('node:fs').appendFileSync('/workspace/ticks','x'),20)",
				],
				{ timeoutMs: 300 },
			),
		).rejects.toThrow("timeout");
		const first = await run.executor.dispatchTool(run.runId, [
			"cat",
			"/workspace/ticks",
		]);
		await Bun.sleep(120);
		const second = await run.executor.dispatchTool(run.runId, [
			"cat",
			"/workspace/ticks",
		]);
		expect(first.code).toBe(0);
		expect(first.stdout.length).toBeGreaterThan(0);
		expect(second.stdout).toBe(first.stdout);
	} finally {
		await run.close();
	}
});

test("default executor forwards abort into the running guest command @unit", async () => {
	const run = await liveExecutor(),
		controller = new AbortController();
	try {
		const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
		const record = run.executor.runRecord(run.runId);
		if (!record) throw new Error("missing live fixture record");
		const command = run.executor.dispatchTool(
			run.runId,
			[
				"/usr/local/bin/bun",
				"-e",
				"require('node:fs').writeFileSync('/workspace/abort-ticks','x');setInterval(()=>require('node:fs').appendFileSync('/workspace/abort-ticks','x'),20)",
			],
			{ timeoutMs: 5000, signal: controller.signal },
		);
		const stopped = expect(command).rejects.toThrow("aborted");
		await expect
			.poll(
				async () =>
					(
						await runArgv([
							"docker",
							"exec",
							record.containerId,
							"test",
							"-f",
							"/workspace/abort-ticks",
						])
					).code,
			)
			.toBe(0);
		controller.abort();
		await stopped;
		const first = await run.executor.dispatchTool(run.runId, [
			"cat",
			"/workspace/abort-ticks",
		]);
		await Bun.sleep(100);
		const second = await run.executor.dispatchTool(run.runId, [
			"cat",
			"/workspace/abort-ticks",
		]);
		expect(first.code).toBe(0);
		expect(second.stdout).toBe(first.stdout);
	} finally {
		controller.abort();
		await run.close();
	}
});

test("quiescence cancels active work and closes further tool intake @unit", async () => {
	const run = await liveExecutor();
	try {
		const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
		const record = run.executor.runRecord(run.runId);
		if (!record) throw new Error("missing live fixture record");
		const work = run.executor
			.dispatchTool(
				run.runId,
				[
					"/usr/local/bin/bun",
					"-e",
					"require('node:fs').writeFileSync('/workspace/quiet-ticks','x');setInterval(()=>require('node:fs').appendFileSync('/workspace/quiet-ticks','x'),20)",
				],
				{ timeoutMs: 5000 },
			)
			.catch((error: unknown) => error);
		await expect
			.poll(
				async () =>
					(
						await runArgv([
							"docker",
							"exec",
							record.containerId,
							"test",
							"-f",
							"/workspace/quiet-ticks",
						])
					).code,
			)
			.toBe(0);
		await run.executor.quiesce(run.runId);
		expect(await work).toBeInstanceOf(Error);
		await expect(
			run.executor.dispatchTool(run.runId, ["true"]),
		).rejects.toThrow("intake closed");
		const first = await runArgv([
			"docker",
			"exec",
			record.containerId,
			"cat",
			"/workspace/quiet-ticks",
		]);
		await Bun.sleep(100);
		const second = await runArgv([
			"docker",
			"exec",
			record.containerId,
			"cat",
			"/workspace/quiet-ticks",
		]);
		expect(first.code).toBe(0);
		expect(second.stdout).toBe(first.stdout);
	} finally {
		await run.close();
	}
});

test("untracked process residue refuses checkpointing and destroys the guest @unit", async () => {
	const run = await liveExecutor();
	try {
		const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
		const record = run.executor.runRecord(run.runId);
		if (!record) throw new Error("missing live fixture record");
		const launched = await run.executor.dispatchTool(run.runId, [
			"sh",
			"-c",
			"setsid /usr/local/bin/bun -e \"require('node:fs').writeFileSync('/workspace/escape-ticks','x');setInterval(()=>{},20)\" >/dev/null 2>&1 </dev/null &",
		]);
		expect(launched.code).toBe(0);
		await expect
			.poll(
				async () =>
					(
						await runArgv([
							"docker",
							"exec",
							record.containerId,
							"test",
							"-f",
							"/workspace/escape-ticks",
						])
					).code,
			)
			.toBe(0);
		await expect(run.executor.quiesce(run.runId)).rejects.toThrow("residue");
		const stopped = await runArgv([
			"docker",
			"inspect",
			"--format",
			"{{.State.Running}}",
			record.containerId,
		]);
		if (stopped.code === 0) expect(stopped.stdout.trim()).toBe("false");
		else expect(stopped.stderr).toMatch(/no such (?:object|container)/i);
		// Docker's --rm cleanup follows process termination asynchronously.
		await expect
			.poll(
				async () =>
					(await runArgv(["docker", "inspect", record.containerId])).code,
			)
			.not.toBe(0);
		expect(
			(await runArgv(["docker", "inspect", record.containerId])).stderr,
		).toMatch(/no such (?:object|container)/i);
	} finally {
		await run.close();
	}
});

test("stop closes the transport intake before another command can run @unit", async () => {
	const run = await liveExecutor();
	try {
		await run.executor.dispatchTool(run.runId, ["true"]);
		await run.executor.stop(run.runId);
		await expect(
			run.executor.dispatchTool(run.runId, ["true"]),
		).rejects.toThrow("intake closed");
	} finally {
		await run.close();
	}
});

test("a lost record cannot strand the known live guest during stop @unit", async () => {
	const run = await liveExecutor();
	const record = run.executor.runRecord(run.runId);
	if (!record) throw new Error("missing live fixture record");
	const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
	try {
		const { unlink } = await import("node:fs/promises");
		await unlink(join(record.seedDir, "..", "executor.json"));
		await run.executor.stop(run.runId);
		const state = await runArgv([
			"docker",
			"inspect",
			"--format",
			"{{.State.Running}}",
			record.containerId,
		]);
		if (state.code === 0) expect(state.stdout.trim()).toBe("false");
		else expect(state.stderr).toMatch(/no such (?:object|container)/i);
	} finally {
		const removed = await runArgv(["docker", "rm", "-f", record.containerId]);
		if (removed.code !== 0)
			expect(removed.stderr).toMatch(/no such (?:object|container)/i);
		await run.close();
	}
});

for (const failure of [new Error("fixture cleanup failed"), undefined])
	test(`cleanup failure remains loud after guest stop (${failure === undefined ? "undefined" : "Error"}) @unit`, async () => {
		const run = await liveExecutor({
			processTransportFactory: async (record) => {
				const { createRemoteProcessTransport } = await import(
					"../hooks/lib/runners/desktop/remote-process.ts"
				);
				const actual = await createRemoteProcessTransport({
					containerId: record.containerId,
					expectedPinnedImageRef: record.image,
					deadlineAt: record.deadlineAt,
				});
				return {
					...actual,
					cleanup: async () => {
						await actual.cleanup();
						throw failure;
					},
				};
			},
		});
		try {
			const { runArgv } = await import("../hooks/lib/runners/desktop/spawn.ts");
			const record = run.executor.runRecord(run.runId);
			if (!record) throw new Error("missing live fixture record");
			await run.executor.dispatchTool(run.runId, ["true"]);
			await expect(run.executor.stop(run.runId)).rejects.toThrow(
				"cleanup failed",
			);
			await expect
				.poll(
					async () =>
						(await runArgv(["docker", "inspect", record.containerId])).code,
				)
				.not.toBe(0);
			expect(
				(await runArgv(["docker", "inspect", record.containerId])).stderr,
			).toMatch(/no such (?:object|container)/i);
		} finally {
			await run.close();
		}
	});
