import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerSettingsSchema } from "@klh/settings";
import { serveStub } from "@klh/test-kit";
import {
	containerNameOf,
	resolvedPolicyDigest,
} from "../hooks/lib/runners/desktop/docker-executor.ts";
import { DESKTOP_RUNNER_IMAGE } from "../hooks/lib/runners/desktop/prereqs.ts";
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

async function until(ready: () => boolean, failure: string) {
	const deadline = performance.now() + 10_000;
	while (!ready()) {
		if (performance.now() >= deadline) throw new Error(failure);
		await Bun.sleep(50);
	}
}

export async function runSandboxCanary(image = DESKTOP_RUNNER_IMAGE) {
	const imageId = await checkDesktopImage(image);
	const home = await mkdtemp(join(tmpdir(), "runner-live-sandbox-"));
	const seedRoot = join(home, "seed");
	const stateDir = join(home, "state");
	const workspacesDir = join(stateDir, "workspaces");
	const profilesFile = join(home, "profiles.json");
	const mintFile = join(home, "mint.key");
	const ownerFile = join(home, "owner.key");
	const runId = crypto.randomUUID();
	const name = containerNameOf(runId);
	const marker = crypto.randomUUID();
	let requests = 0;
	let revoked = false;
	let toolResult: unknown;
	let toolResultAt = 0;
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
			if (requests === 2) {
				toolResult = body?.messages;
				toolResultAt = performance.now();
			}
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
		const started = performance.now();
		const admit = await post("", { profile: "standard", runId });
		assert.equal(admit.status, 201, await admit.text());
		const submit = await post(`/${runId}/submit`, {
			requestId: crypto.randomUUID(),
			text: "Read the seed marker.",
		});
		assert.equal(submit.ok, true, await submit.text());
		const readyMs = performance.now() - started;
		await until(
			() => JSON.stringify(toolResult)?.includes(marker) ?? false,
			"sandbox tool result missing",
		);
		const abort = await post(`/${runId}/abort`, {});
		assert.deepEqual(await abort.json(), { ok: true, state: "stopped" });
		assert.equal(revoked, true);
		await until(
			() =>
				/No such (object|container)/i.test(
					docker("inspect", name).stderr.toString(),
				),
			"sandbox container remains",
		);
		return {
			runId,
			image,
			imageId,
			arch: process.arch,
			readyMs,
			usefulMs: toolResultAt - started,
			requests,
			revoked,
			containerRemoved: true,
		};
	} finally {
		await host?.stop();
		authority.close();
		if (docker("inspect", name).exitCode === 0) docker("rm", "--force", name);
		await rm(home, { recursive: true, force: true });
	}
}

if (import.meta.main) console.log(JSON.stringify(await runSandboxCanary()));
