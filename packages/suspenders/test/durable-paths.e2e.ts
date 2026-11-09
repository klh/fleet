import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

test("Durable storage refuses public job directories and state symlinks @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	for (const unsafe of ["public", "state-symlink", "manifest-symlink"]) {
		const world = scratchWorld({ prefix: "durable-path-" });
		const spec = {
			version: 1,
			runId: randomUUID(),
			owner: "fixture",
			generation: 1,
			kind: "knowledge",
			seedDigest: "a".repeat(64),
			policyDigest: "b".repeat(64),
			provider: "fixture",
			model: "fixture",
		};
		const directory = join(world.home, spec.runId);
		mkdirSync(directory, { mode: 0o700 });
		if (unsafe === "public") chmodSync(directory, 0o755);
		else
			symlinkSync(
				unsafe === "state-symlink"
					? world.repo
					: join(world.repo, "missing.json"),
				join(directory, unsafe === "state-symlink" ? "state" : "manifest.json"),
			);
		try {
			await expect(
				openDurableJob({
					root: world.home,
					spec,
					runtime: { models: createModels(), registry: createRegistry() },
					authorize: async () => {},
				}),
			).rejects.toThrow(/private|symlink/);
		} finally {
			world.clean();
		}
	}
});
