import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("actual hubctl push discovers selected provider models before writing generated routes", async () => {
	const world = scratchWorld();
	let calls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			calls++;
			expect(new URL(request.url).pathname).toBe("/v1/models");
			return Response.json({
				data: [
					{
						id: "operator-selected-model",
						context_length: 4096,
						max_output_tokens: 512,
						reasoning: false,
					},
				],
			});
		},
	});
	const root = join(import.meta.dir, "../../..");
	try {
		const doc = JSON.parse(
			readFileSync(join(root, "settings.template.json"), "utf8"),
		);
		doc.version = "2.2.0";
		doc.providers = {
			selected: {
				kind: "provider",
				provider: "fixture",
				adapter: "openai",
				endpoints: { openai: `http://127.0.0.1:${server.port}/v1` },
			},
			unselected: {
				kind: "provider",
				provider: "fixture",
				adapter: "openai",
				endpoints: { openai: "https://unselected.example/v1" },
				auth: { kind: "file", path: join(world.home, "absent-unselected-key") },
			},
		};
		const output = join(world.home, "generated"),
			settings = join(world.home, "settings.json");
		doc.hubs = {
			fixture: {
				host: "127.0.0.1",
				provider_requirements: ["selected"],
				deploy: { dir: output },
			},
		};
		writeFileSync(settings, JSON.stringify(doc), { mode: 0o600 });
		const child = Bun.spawn(
			[
				process.execPath,
				join(root, "packages/suspenders/deploy/hubctl.ts"),
				"push",
				"fixture",
			],
			{
				env: {
					...world.env,
					KLH_SETTINGS: settings,
					KLH_STACK: join(world.home, "absent-stack.json"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		try {
			expect(await child.exited, await new Response(child.stderr).text()).toBe(
				0,
			);
		} finally {
			clearTimeout(timer);
			child.kill("SIGKILL");
			await child.exited;
		}
		const rendered = JSON.parse(
			readFileSync(join(output, "upstreams.hub.json"), "utf8"),
		);
		expect(calls).toBe(1);
		expect(rendered.groups["operator-selected-model"][0]).toMatchObject({
			providerProfile: "selected",
			model: "operator-selected-model",
			capabilities: {
				context_length: 4096,
				max_output_tokens: 512,
				reasoning: false,
			},
		});
		expect(rendered.inherit_defaults).toBe(false);
	} finally {
		server.stop(true);
		world.clean();
	}
});
