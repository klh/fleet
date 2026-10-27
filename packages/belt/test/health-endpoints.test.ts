import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	freePort,
	scratchWorld,
	serveStub,
	waitUp,
} from "../../test-kit/src/index.ts";

async function withService(
	script: string,
	portEnv: string,
	check: (base: string) => Promise<void>,
	extra: Record<string, string> = {},
) {
	const port = await freePort();
	const { env, clean } = scratchWorld({ prefix: "fleet-health-" });
	const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, script)], {
		env: { ...env, [portEnv]: String(port), ...extra },
		stdout: "ignore",
		stderr: "ignore",
	});
	const base = `http://127.0.0.1:${port}`;
	try {
		try {
			await waitUp(`${base}/health`, { tries: 100, intervalMs: 20 });
		} catch {
			throw new Error(`service failed to start: ${script}`);
		}
		await check(base);
	} finally {
		proc.kill();
		await proc.exited;
		clean();
	}
}

for (const [script, portEnv] of [
	["../bin/dashboard.ts", "BELT_PORT"],
	["../../local/bin/dashboard.ts", "KLH_LOCAL_BAR_PORT"],
	// W465: the local-llm router-shim twin is retired — belt's is the ONE
	// router; the liveness contract is asserted against it.
	["../bin/router-shim.ts", "BELT_ROUTER_PORT"],
]) {
	test(`${script}: live aliases and methods work over HTTP`, async () => {
		await withService(script, portEnv, async (base) => {
			for (const path of [
				"/health",
				"/health/liveness",
				"/health/liveliness",
			]) {
				const get = await fetch(`${base}${path}`);
				expect(get.status).toBe(200);
				expect(await get.json()).toMatchObject({
					ok: true,
					check: "process-liveness",
				});
				const head = await fetch(`${base}${path}`, { method: "HEAD" });
				expect(head.status).toBe(200);
				expect(await head.text()).toBe("");
				expect((await fetch(`${base}${path}`, { method: "POST" })).status).toBe(
					405,
				);
			}
			if (script.includes("dashboard")) {
				if (script === "../bin/dashboard.ts") {
					const asset = await fetch(`${base}/dashboard-observability.js`);
					expect(asset.headers.get("content-type")).toContain("javascript");
					const source = await asset.text();
					expect(source).toContain("const displayLabel =");
					expect(source).toContain("displayLabel(target.name)");
					// W853: hub/container posture never has a supervisor snapshot —
					// the panel removes itself instead of a standing red "unknown".
					expect(source).not.toContain("No supervisor snapshot");
					expect(source).toContain("!doc && !this.error");
					const built = await Bun.build({
						entrypoints: ["observability.js"],
						plugins: [
							{
								name: "served-asset",
								setup(build) {
									build.onResolve({ filter: /^observability\.js$/ }, () => ({
										path: "observability.js",
										namespace: "served",
									}));
									build.onLoad({ filter: /.*/, namespace: "served" }, () => ({
										contents: source,
										loader: "js",
									}));
								},
							},
						],
						external: [
							"/vendor/lit.js",
							"/dashboard-state.js",
							"/observation.js",
						],
					});
					expect(built.success).toBe(true);
				}
				expect(
					(await fetch(`${base}/api/status`, { method: "POST" })).status,
				).toBe(405);
				expect(
					(await fetch(`${base}/api/status`, { method: "OPTIONS" })).status,
				).toBe(204);
			}
		});
	});
}

test("minimal shim separates process liveness from backend model availability", async () => {
	const backend = serveStub(
		() => new Response("backend down", { status: 503 }),
	);
	try {
		await withService(
			"../bin/anthropic-shim.ts",
			"SHIM_PORT",
			async (base) => {
				expect((await fetch(`${base}/health`)).status).toBe(200);
				expect((await fetch(`${base}/v1/models`)).status).toBe(503);
				backend.close();
				expect((await fetch(`${base}/health/liveliness`)).status).toBe(200);
				expect((await fetch(`${base}/v1/models`)).status).toBe(503);
			},
			{ MLX_BASE: `http://127.0.0.1:${backend.port}` },
		);
	} finally {
		backend.close();
	}
});

test("local CLI observes the registered upstream and rejects failed HTTP checks", async () => {
	const server = serveStub(() =>
		Response.json({ healthy: false }, { status: 503 }),
	);
	const { home, env, clean } = scratchWorld({ prefix: "fleet-health-cli-" });
	const state = join(home, ".local/state/klh-local");
	mkdirSync(state, { recursive: true });
	writeFileSync(
		join(state, "registry.json"),
		JSON.stringify([
			{
				name: "fixture",
				port: 1,
				upstream: `127.0.0.1:${server.port}`,
				health_path: "/health",
				dns: { claimed: false },
				caddy: { conf_path: join(state, "fixture.caddy") },
				created_at: new Date().toISOString(),
			},
		]),
	);
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				resolve(import.meta.dir, "../../local/bin/klh-local.ts"),
				"status",
			],
			{ env, stdout: "pipe", stderr: "pipe" },
		);
		const output = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(output).toContain("health   fail");
		expect(output).toContain(`GET 127.0.0.1:${server.port}/health`);
	} finally {
		server.close();
		clean();
	}
});
