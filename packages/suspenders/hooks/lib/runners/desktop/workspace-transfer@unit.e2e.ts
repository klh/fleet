import { open, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	captureWorkspace,
	restoreWorkspace,
	validateWorkspaceFile,
} from "./workspace-transfer.ts";
import type { ExecutorRecord } from "./docker-executor.ts";

function record(): ExecutorRecord {
	return {
		runId: crypto.randomUUID(),
		containerId: "c".repeat(64),
		containerName: "fixture",
		image: `fixture/tool@sha256:${"d".repeat(64)}`,
		seedDir: "fixture",
		argv: [],
		expired: false,
		executed: true,
		startedAt: Date.now(),
		deadlineAt: Date.now() + 200,
	};
}
const ignoringTerm = [
	"bun",
	"-e",
	'process.on("SIGTERM", () => {}); setInterval(() => {}, 10);',
];

test("capture timeout hard-kills and joins a HOST client ignoring SIGTERM @unit", async () => {
	const world = scratchWorld(),
		execution = record(),
		start = Date.now();
	try {
		await expect(
			captureWorkspace({
				deps: {
					image: execution.image,
					seedRoot: world.home,
					workspacesDir: world.home,
					dockerBin: "nonexistent-capture-client",
					dockerArgv: () => ignoringTerm,
				},
				record: execution,
				root: world.home,
				maxBytes: 4096,
				binding: {
					job: {
						spec: {
							version: 1,
							runId: execution.runId,
							owner: "fixture",
							generation: 1,
							kind: "coding",
							provider: "fixture",
							model: "fixture",
							seedDigest: "a".repeat(64),
							policyDigest: "b".repeat(64),
						},
						runtime: "pi-durable@1.5.0",
						host: hostname(),
					},
					image: execution.image,
					deadlineAt: execution.deadlineAt ?? 0,
					leaseEpoch: 1,
					conversationId: "1",
				},
			}),
		).rejects.toThrow();
		expect(Date.now() - start).toBeLessThan(2000);
		expect(await readdir(world.home)).toEqual([]);
	} finally {
		world.clean();
	}
});

test("binary restore timeout hard-kills and joins a HOST client ignoring SIGTERM @unit", async () => {
	const world = scratchWorld(),
		execution = record(),
		path = join(world.home, "archive.tar");
	await writeFile(path, new Uint8Array(1024), { mode: 0o600 });
	const file = await open(path, "r"),
		start = Date.now();
	try {
		await validateWorkspaceFile(file, 4096);
		await expect(
			restoreWorkspace({
				deps: {
					image: execution.image,
					seedRoot: world.home,
					workspacesDir: world.home,
					dockerBin: "nonexistent-restore-client",
					dockerArgv: () => ignoringTerm,
				},
				record: execution,
				file,
				maxBytes: 4096,
			}),
		).rejects.toThrow("tar restore failed");
		expect(Date.now() - start).toBeLessThan(2000);
	} finally {
		await file.close();
		world.clean();
	}
});
