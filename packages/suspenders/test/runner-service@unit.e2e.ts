import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { join } from "node:path";
import { writeFile, symlink, chmod } from "node:fs/promises";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import { openRunnerHost } from "../hooks/lib/runners/service/host.ts";
import { readRunnerProfiles } from "../hooks/lib/runners/service/profiles.ts";

test("runner host reopens admitted jobs and excludes a second writer @unit", async () => {
	const world = scratchWorld({ prefix: "runner-service-" });
	const profilesFile = join(world.home, "profiles.json");
	const linkedProfiles = join(world.home, "linked.json");
	await writeFile(
		profilesFile,
		JSON.stringify({
			standard: {
				version: 1,
				generation: 1,
				kind: "coding",
				seedDigest: "a".repeat(64),
				policyDigest: "b".repeat(64),
				provider: "belt",
				model: "glm-5.3",
			},
		}),
		{ mode: 0o600 },
	);
	await symlink(profilesFile, linkedProfiles);
	expect(() => readRunnerProfiles(linkedProfiles)).toThrow();
	await chmod(profilesFile, 0o644);
	expect(() => readRunnerProfiles(profilesFile)).toThrow(
		"private_file_required",
	);
	await chmod(profilesFile, 0o600);
	const options: Parameters<typeof openRunnerHost>[0] = {
		stateDir: join(world.home, "runner"),
		profilesFile,
		port: 0,
		identity: async () => ({
			keyId: "fixture",
			kind: "api_key",
			scopes: ["buckle:runner:WRITE_"],
		}),
		openRuntime: async ({ store }) => ({
			controller: openRunnerController({ store }),
			async close() {},
		}),
	};
	let host = await openRunnerHost(options);
	try {
		await expect(openRunnerHost(options)).rejects.toThrow("writer unavailable");
		const runId = crypto.randomUUID();
		const response = await fetch(new URL("/v1/runner/runs", host.url), {
			method: "POST",
			body: JSON.stringify({ profile: "standard", runId }),
		});
		expect(response.status).toBe(201);
		await host.stop();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		host = await openRunnerHost({
			...options,
			async identity(request) {
				entered.resolve();
				await release.promise;
				return options.identity(request);
			},
		});
		const pending = fetch(new URL(`/v1/runner/runs/${runId}`, host.url));
		await entered.promise;
		const stopping = host.stop();
		release.resolve();
		expect((await pending).status).toBe(200);
		await stopping;
	} finally {
		await host.stop();
		world.clean();
	}
});
