import { expect, test } from "@playwright/test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProviderConfig } from "../src/settings.connection-resolver.ts";
import { envRestore, envSnapshot, scratchSettingsHome } from "./helpers.ts";

test("selected peers do not open absent/FIFO unselected provider credentials; selected failures refuse", () => {
	const world = scratchSettingsHome(),
		saved = envSnapshot();
	try {
		process.env.KLH_SETTINGS = world.file;
		const missing = join(world.home, "absent-cloud-key"),
			fifo = join(world.home, "cloud-fifo");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		chmodSync(fifo, 0o600);
		for (const path of [missing, fifo]) {
			writeFileSync(
				world.file,
				JSON.stringify({
					providers: {
						peer: {
							kind: "buckle",
							adapter: "buckle",
							endpoints: { openai: "https://selected-peer.example/v1" },
						},
						cloud: {
							kind: "provider",
							provider: "fixture",
							adapter: "openai",
							endpoints: { openai: "https://unselected.example/v1" },
							auth: { kind: "file", path },
						},
					},
				}),
				{ mode: 0o600 },
			);
			chmodSync(world.file, 0o600);
			expect(Object.keys(loadProviderConfig(undefined, ["peer"]))).toEqual([
				"peer",
			]);
			expect(() => loadProviderConfig(undefined, ["cloud"])).toThrow(
				"Invalid private connection",
			);
			expect(() => loadProviderConfig()).toThrow("Invalid private connection");
		}
	} finally {
		envRestore(saved);
		world.clean();
	}
});
