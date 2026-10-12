import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function withService(
	script: string,
	portEnv: string,
	check: (base: string) => Promise<void>,
	extra: Record<string, string> = {},
) {
	const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = reservation.port;
	reservation.stop(true);
	const home = mkdtempSync(join(tmpdir(), "fleet-health-"));
	const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, script)], {
		env: { ...process.env, HOME: home, [portEnv]: String(port), ...extra },
		stdout: "ignore",
		stderr: "ignore",
	});
	const base = `http://127.0.0.1:${port}`;
	try {
		let ready = false;
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(`${base}/health`)).ok) {
					ready = true;
					break;
				}
			} catch {}
			await Bun.sleep(20);
		}
		if (!ready) throw new Error(`service failed to start: ${script}`);
		await check(base);
	} finally {
		proc.kill();
		await proc.exited;
		rmSync(home, { recursive: true, force: true });
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
	const backend = Bun.serve({
		port: 0,
		fetch: () => new Response("backend down", { status: 503 }),
	});
	try {
		await withService(
			"../bin/anthropic-shim.ts",
			"SHIM_PORT",
			async (base) => {
				expect((await fetch(`${base}/health`)).status).toBe(200);
				expect((await fetch(`${base}/v1/models`)).status).toBe(503);
				backend.stop(true);
				expect((await fetch(`${base}/health/liveliness`)).status).toBe(200);
				expect((await fetch(`${base}/v1/models`)).status).toBe(503);
			},
			{ MLX_BASE: `http://127.0.0.1:${backend.port}` },
		);
	} finally {
		backend.stop(true);
	}
});

test("local CLI observes the registered upstream and rejects failed HTTP checks", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ healthy: false }, { status: 503 }),
	});
	const home = mkdtempSync(join(tmpdir(), "fleet-health-cli-"));
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
			{ env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
		);
		const output = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(output).toContain("health   fail");
		expect(output).toContain(`GET 127.0.0.1:${server.port}/health`);
	} finally {
		server.stop(true);
		rmSync(home, { recursive: true, force: true });
	}
});
