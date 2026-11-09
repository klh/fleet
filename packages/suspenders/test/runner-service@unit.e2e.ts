import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunnerSettingsSchema } from "@klh/settings";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import { runnerHostConfig } from "../hooks/lib/runners/service/config.ts";
import { openRunnerHost } from "../hooks/lib/runners/service/host.ts";
import { readRunnerProfiles } from "../hooks/lib/runners/service/profiles.ts";

test("runner host uses only an explicit loopback port and the configured identity authority @unit", async () => {
	const authority = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			expect(new URL(request.url).pathname).toBe("/v1/fleet/whoami");
			expect(request.headers.get("authorization")).toBe("Bearer scoped-key");
			return Response.json({
				authenticated: true,
				kind: "api_key",
				key_id: "operator",
				team: null,
				actor: null,
				scopes: ["buckle:runner:READ_"],
			});
		},
	});
	try {
		const config = RunnerSettingsSchema.parse({
			control_url: "http://127.0.0.1:7810",
			identity_url: authority.url.href,
		});
		const host = runnerHostConfig(config);
		expect(host.port).toBe(7810);
		for (const control_url of ["https://runner.example", "http://127.0.0.1:0"])
			expect(() => runnerHostConfig({ ...config, control_url })).toThrow(
				"runner.local_listener_requires_loopback_port",
			);
		const identity = await host.identity(
			new Request(authority.url, {
				headers: { authorization: "Bearer scoped-key" },
			}),
		);
		expect(identity.keyId).toBe("operator");
	} finally {
		await authority.stop(true);
	}
});

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
		const probe = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const control_url = probe.url.href;
		await probe.stop(true);
		const settingsFile = join(world.home, "settings.json");
		await writeFile(
			settingsFile,
			JSON.stringify({
				runner: {
					control_url,
					profiles_file: profilesFile,
					state_dir: options.stateDir,
				},
			}),
			{ mode: 0o600 },
		);
		const lib = new URL("../hooks/lib/runners/", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
			import { runRunnerService } from ${JSON.stringify(`${lib}service/process.ts`)};
			import { openRunnerController } from ${JSON.stringify(`${lib}control/controller.ts`)};
			await runRunnerService({ openRuntime: async ({ store }) => ({
				controller: openRunnerController({ store }), async close() {}
			}) });
		`,
			],
			{
				env: { ...world.env, KLH_SETTINGS: settingsFile },
				stdout: "pipe",
				stderr: "inherit",
			},
		);
		const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
		const stdout = child.stdout.getReader();
		try {
			const first = await stdout.read();
			expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({
				control: "listening",
				url: control_url,
			});
			child.kill("SIGTERM");
			expect(await child.exited).toBe(0);
			host = await openRunnerHost(options);
		} finally {
			clearTimeout(deadline);
			stdout.releaseLock();
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		}
	} finally {
		await host.stop();
		world.clean();
	}
});
