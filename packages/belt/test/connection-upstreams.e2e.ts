import { expect, test } from "@playwright/test";
import { scratchWorld } from "@klh/test-kit";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleProviderResolver, probeClosure } from "../bin/runtime-heal.ts";

test("flat installed peer emitter executes its actual bundled dependency closure @unit", async () => {
	const world = scratchWorld();
	try {
		const settings = join(world.home, "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({
				providers: {
					peer: {
						kind: "buckle",
						adapter: "buckle",
						endpoints: { openai: "https://peer.example/v1" },
					},
					unselected: {
						kind: "provider",
						provider: "fixture",
						adapter: "openai",
						endpoints: { openai: "https://unselected.example/v1" },
						auth: {
							kind: "file",
							path: join(world.home, "absent-unselected-key"),
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		await bundleProviderResolver(join(import.meta.dir, "../../.."), world.home);
		expect(probeClosure(world.home, ["connection-upstreams.ts"])).toEqual([]);
		const run = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				'const {emitPeerUpstreams}=await import("./connection-upstreams.ts");console.log(await emitPeerUpstreams(["peer"],{},undefined,async()=>Response.json({data:[{id:"observed-peer-model"}]})))',
			],
			{
				cwd: world.home,
				env: {
					...world.env,
					KLH_SETTINGS: settings,
					KLH_STACK: join(world.home, "absent-stack.json"),
				},
				timeout: 5000,
				killSignal: "SIGKILL",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		const doc = JSON.parse(run.stdout.toString());
		expect(doc.inherit_defaults).toBe(false);
		expect(doc.groups["observed-peer-model"][0]).toMatchObject({
			buckle: true,
			providerProfile: "peer",
			model: "observed-peer-model",
			url: "https://peer.example/v1",
		});
	} finally {
		world.clean();
	}
});
