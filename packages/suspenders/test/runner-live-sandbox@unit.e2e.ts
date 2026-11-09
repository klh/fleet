import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunnerSettingsSchema } from "@klh/settings";
import { scratchWorld, serveStub } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	containerNameOf,
	resolvedPolicyDigest,
} from "../hooks/lib/runners/desktop/docker-executor.ts";
import { DESKTOP_RUNNER_IMAGE as image } from "../hooks/lib/runners/desktop/prereqs.ts";
import {
	canonicalSeedDigest,
	scanSeedDir,
} from "../hooks/lib/runners/desktop/seed.ts";
import { runnerHostConfig } from "../hooks/lib/runners/service/config.ts";
import {
	checkDesktopImage,
	runnerDockerArgv,
} from "../hooks/lib/runners/service/desktop-preflight.ts";
import { desktopRuntime } from "../hooks/lib/runners/service/desktop-runtime.ts";
import { openRunnerHost } from "../hooks/lib/runners/service/host.ts";
import { fixtureResponse } from "./durable-runtime.fixtures.ts";

test("runner HTTP admission executes a seeded sandbox tool using only its minted key", async () => {
	test.setTimeout(45_000);
	const imageId = await checkDesktopImage(image).catch(() => null);
	test.skip(!imageId, "Pinned native runner image must already be present");
	const world = scratchWorld({ prefix: "runner-live-sandbox-" });
	const seedRoot = join(world.home, "seed");
	const stateDir = join(world.home, "state");
	const workspacesDir = join(stateDir, "workspaces");
	const profilesFile = join(world.home, "profiles.json");
	const mintFile = join(world.home, "mint.key");
	const ownerFile = join(world.home, "owner.key");
	const runId = crypto.randomUUID();
	const name = containerNameOf(runId);
	const marker = crypto.randomUUID();
	let requests = 0;
	let revoked = false;
	let toolResult: unknown;
	const authority = serveStub((request, body) => {
		const path = new URL(request.url).pathname;
		const auth = request.headers.get("authorization");
		if (path === "/v1/fleet/whoami") {
			const scopes =
				auth === "Bearer fixture-mint"
					? ["buckle:admin:WRITE_"]
					: auth === "Bearer fixture-owner"
						? ["buckle:runner:WRITE_"]
						: [];
			if (!scopes.length) return new Response(null, { status: 403 });
			return Response.json({
				authenticated: true,
				kind: "api_key",
				key_id: auth,
				team: null,
				actor: null,
				scopes,
			});
		}
		if (path === "/v1/admin/keys" && auth === "Bearer fixture-mint")
			return Response.json(
				{
					key_id: "fixture-run",
					key: "fixture-model-key",
					name: "fixture",
					scopes: ["buckle:proxy:WRITE_"],
					expires_at: Date.now() + 3_600_000,
				},
				{ status: 201 },
			);
		if (
			path === "/v1/admin/keys/fixture-run/revoke" &&
			auth === "Bearer fixture-mint"
		) {
			revoked = true;
			return Response.json({ revoked: "fixture-run" });
		}
		if (
			path === "/v1/chat/completions" &&
			auth === "Bearer fixture-model-key" &&
			!revoked
		) {
			requests++;
			if (requests === 2) toolResult = body?.messages;
			return fixtureResponse(requests, {
				name: "desktop_sandbox_exec",
				arguments: JSON.stringify({ argv: ["cat", "/seed/marker"] }),
			});
		}
		return new Response(null, { status: 403 });
	});
	let host: Awaited<ReturnType<typeof openRunnerHost>> | undefined;
	const docker = (...args: string[]) =>
		Bun.spawnSync(runnerDockerArgv(["docker", ...args]));
	try {
		await mkdir(seedRoot, { mode: 0o700 });
		await Promise.all([
			writeFile(join(seedRoot, "marker"), marker, { mode: 0o600 }),
			writeFile(mintFile, "fixture-mint\n", { mode: 0o600 }),
			writeFile(ownerFile, "fixture-owner\n", { mode: 0o600 }),
		]);
		await writeFile(
			profilesFile,
			JSON.stringify({
				standard: {
					version: 1,
					generation: 1,
					kind: "coding",
					seedDigest: canonicalSeedDigest(await scanSeedDir(seedRoot)),
					policyDigest: resolvedPolicyDigest({
						image,
						seedRoot,
						workspacesDir,
					}),
					provider: "belt",
					model: "fixture",
				},
			}),
			{ mode: 0o600 },
		);
		const config = RunnerSettingsSchema.parse({
			control_url: "http://127.0.0.1:7810",
			identity_url: authority.url,
			state_dir: stateDir,
			profiles_file: profilesFile,
			credential_file: ownerFile,
			desktop: { image, seed_root: seedRoot, mint_credential_file: mintFile },
		});
		host = await openRunnerHost({
			...runnerHostConfig(config),
			port: 0,
			...(await desktopRuntime(config, stateDir)),
		});
		const base = new URL("/v1/runner/runs", host.url);
		const headers = {
			authorization: "Bearer fixture-owner",
			"content-type": "application/json",
		};
		const post = (suffix: string, body: unknown) =>
			fetch(base.href + suffix, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(25_000),
			});
		const admit = await post("", { profile: "standard", runId });
		expect(admit.status, await admit.text()).toBe(201);
		const submit = await post(`/${runId}/submit`, {
			requestId: crypto.randomUUID(),
			text: "Read the seed marker.",
		});
		expect(submit.ok, await submit.text()).toBe(true);
		await expect.poll(() => JSON.stringify(toolResult) ?? "").toContain(marker);
		const abort = await post(`/${runId}/abort`, {});
		expect(await abort.json()).toMatchObject({ ok: true, state: "stopped" });
		expect(revoked).toBe(true);
		await expect
			.poll(() => docker("inspect", name).stderr.toString())
			.toMatch(/No such (object|container)/i);
	} finally {
		await host?.stop();
		authority.close();
		if (docker("inspect", name).exitCode === 0) docker("rm", "--force", name);
		world.clean();
	}
});
