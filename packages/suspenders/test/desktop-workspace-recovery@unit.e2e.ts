import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { RunnerSpecSchema } from "../hooks/lib/runners/control/control-state.ts";
import {
	canonicalPolicyDigest,
	createDesktopDockerExecutor,
	type DesktopExecutorDeps,
	ExecutorRecordSchema,
} from "../hooks/lib/runners/desktop/docker-executor.ts";
import { canonicalSeedDigest } from "../hooks/lib/runners/desktop/seed.ts";
import type { RunArgv } from "../hooks/lib/runners/desktop/spawn.ts";

async function rig(deadlineMs = 60_000, execCode = 0) {
	const world = scratchWorld();
	const seedRoot = join(world.home, "seed"),
		workspacesDir = join(world.home, "workspaces");
	await mkdir(seedRoot, { mode: 0o700 });
	await mkdir(workspacesDir, { mode: 0o700 });
	const bytes = new TextEncoder().encode("seed\n");
	await writeFile(join(seedRoot, "seed.txt"), bytes);
	const runId = crypto.randomUUID();
	const record = async () =>
		ExecutorRecordSchema.parse(
			JSON.parse(
				await readFile(join(workspacesDir, runId, "executor.json"), "utf8"),
			),
		);
	const state = { alive: false, launches: 0, executedBeforeDispatch: false };
	const runDocker: RunArgv = async (argv) => {
		const command = argv[1];
		if (command === "run") {
			state.alive = true;
			return { code: 0, stdout: `container-${++state.launches}`, stderr: "" };
		}
		if (command === "exec") {
			state.executedBeforeDispatch = (await record()).executed;
			return { code: execCode, stdout: "workspace changed", stderr: "" };
		}
		if (command === "inspect" && state.alive)
			return { code: 0, stdout: "true", stderr: "" };
		if (command === "stop" || command === "rm") {
			state.alive = false;
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "No such container" };
	};
	const limits = {
		memoryMb: 128,
		cpus: 1,
		pidsLimit: 64,
		workMb: 16,
		tmpMb: 8,
		uid: 1000,
	};
	const image = `fixture/tool@sha256:${"a".repeat(64)}`;
	const deps: DesktopExecutorDeps = {
		image,
		seedRoot,
		workspacesDir,
		runDocker,
		processTransportFactory: async (record) => ({
			run: (argv, options) =>
				runDocker(
					["docker", "exec", "-i", record.containerId, ...argv],
					options,
				),
			cleanup: async () => {},
			assertQuiescent: async () => {},
		}),
		deadlineMs,
		...limits,
	};
	const spec = RunnerSpecSchema.parse({
		version: 1,
		runId,
		owner: "fixture-owner",
		generation: 1,
		kind: "coding",
		seedDigest: canonicalSeedDigest([{ path: "seed.txt", bytes }]),
		policyDigest: canonicalPolicyDigest(limits, image),
		provider: "fixture",
		model: "fixture",
	});
	const executor = createDesktopDockerExecutor(deps);
	await executor.start(spec, { signal: new AbortController().signal });
	return {
		runId,
		executor,
		record,
		state,
		recordPath: join(workspacesDir, runId, "executor.json"),
		reopen: (duration = deadlineMs) =>
			createDesktopDockerExecutor({ ...deps, deadlineMs: duration }),
		async close() {
			try {
				await executor.stop(runId);
			} finally {
				world.clean();
			}
		},
	};
}

for (const execCode of [0, 1])
	test(`tool execution is persisted before dispatch with exit ${execCode} @unit`, async () => {
		const data = await rig(60_000, execCode);
		try {
			const result = await data.executor.dispatchTool(data.runId, [
				"fixture-write",
			]);
			expect(result.code).toBe(execCode);
			expect(data.state.executedBeforeDispatch).toBe(true);
			expect((await data.record()).executed).toBe(true);
		} finally {
			await data.close();
		}
	});

test("an executed guest lost without a checkpoint cannot relaunch empty @unit", async () => {
	const data = await rig();
	try {
		await data.executor.dispatchTool(data.runId, ["fixture-write"]);
		data.state.alive = false;
		await expect(data.reopen().ensureRunning(data.runId)).rejects.toThrow(
			"workspace-lost",
		);
		expect(data.state.launches).toBe(1);
	} finally {
		await data.close();
	}
});

test("host configuration changes cannot renew the original deadline @unit", async () => {
	const data = await rig(1_000);
	try {
		await data.executor.stop(data.runId);
		expect((await data.record()).expired).toBe(false);
		await Bun.sleep(1_100);
		await expect(data.reopen(60_000).ensureRunning(data.runId)).rejects.toThrow(
			"deadline expired",
		);
		expect(data.state.launches).toBe(1);
	} finally {
		await data.close();
	}
});

test("legacy records cannot invent an unrecorded original deadline @unit", async () => {
	const data = await rig();
	try {
		const legacy = Object.fromEntries(
			Object.entries(await data.record()).filter(
				([key]) => key !== "deadlineAt",
			),
		);
		await writeFile(data.recordPath, JSON.stringify(legacy));
		await expect(data.reopen().ensureRunning(data.runId)).rejects.toThrow(
			"missing original deadline",
		);
		expect(data.state.launches).toBe(1);
	} finally {
		await data.close();
	}
});
