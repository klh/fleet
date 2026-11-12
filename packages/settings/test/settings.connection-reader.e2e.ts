import { expect, test } from "@playwright/test";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProviderConfig } from "../src/settings.connection-resolver.ts";
import { envRestore, envSnapshot, scratchSettingsHome } from "./helpers.ts";

test("a custom legacy path never relocates the canonical machine authority", () => {
	const world = scratchSettingsHome(),
		saved = envSnapshot();
	try {
		process.env.HOME = world.home;
		delete process.env.KLH_SETTINGS;
		const customLegacy = join(world.home, "different-stack.json");
		writeFileSync(
			customLegacy,
			JSON.stringify({
				providers: { legacy: { provider: "old", key: "fixture-old" } },
			}),
			{ mode: 0o600 },
		);
		world.setFile({
			providers: {
				peer: {
					kind: "buckle",
					adapter: "buckle",
					endpoints: { openai: "http://peer.example/v1" },
				},
			},
		});
		chmodSync(world.file, 0o600);
		expect(Object.keys(loadProviderConfig(customLegacy))).toEqual(["peer"]);
	} finally {
		envRestore(saved);
		world.clean();
	}
});

test("canonical native/keyless entries win without borrowing the legacy key", () => {
	const world = scratchSettingsHome(),
		saved = envSnapshot();
	try {
		process.env.KLH_SETTINGS = world.file;
		const legacy = join(world.confDir, "stack.json");
		writeFileSync(
			legacy,
			JSON.stringify({
				providers: { peer: { provider: "old", key: "forbidden-legacy-value" } },
			}),
			{ mode: 0o600 },
		);
		world.setFile({
			providers: {
				peer: {
					kind: "buckle",
					adapter: "buckle",
					endpoints: { openai: "http://peer.example/v1" },
				},
				audio: {
					kind: "provider",
					provider: "elevenlabs",
					adapter: "elevenlabs",
					protocol: "native",
					endpoints: { base: "https://api.elevenlabs.io" },
					auth: { kind: "inline", key: "fixture-audio-value" },
				},
			},
		});
		chmodSync(world.file, 0o600);
		const parsed = loadProviderConfig(legacy);
		expect(parsed.peer?.key).toBeUndefined();
		expect(parsed.audio?.key).toBe("fixture-audio-value");
		world.writeRaw("{malformed fixture-private-value");
		expect(() => loadProviderConfig(legacy)).toThrow(
			"Invalid private connection configuration",
		);
		chmodSync(world.file, 0o644);
		expect(() => loadProviderConfig(legacy)).toThrow(
			"Invalid private connection configuration",
		);
	} finally {
		envRestore(saved);
		world.clean();
	}
});

test("canonical credential references reject symlinks and insecure modes", () => {
	const world = scratchSettingsHome(),
		saved = envSnapshot();
	try {
		process.env.KLH_SETTINGS = world.file;
		const key = join(world.confDir, "credential"),
			link = join(world.confDir, "linked");
		writeFileSync(key, "fixture-value", { mode: 0o644 });
		symlinkSync(key, link);
		for (const path of [key, link]) {
			world.setFile({
				providers: {
					peer: {
						kind: "buckle",
						adapter: "buckle",
						endpoints: { openai: "http://peer.example/v1" },
						auth: { kind: "file", path },
					},
				},
			});
			chmodSync(world.file, 0o600);
			expect(() => loadProviderConfig()).toThrow(
				"Invalid private connection configuration",
			);
		}
		chmodSync(key, 0o600);
		world.setFile({
			providers: {
				peer: {
					kind: "buckle",
					adapter: "buckle",
					endpoints: { openai: "http://peer.example/v1" },
					auth: { kind: "file", path: key },
				},
			},
		});
		chmodSync(world.file, 0o600);
		writeFileSync(key, "A".repeat(4096));
		expect(loadProviderConfig().peer?.key).toHaveLength(4096);
		writeFileSync(key, `${"A".repeat(4096)}\n`);
		expect(() => loadProviderConfig()).toThrow(
			"Invalid private connection configuration",
		);
	} finally {
		envRestore(saved);
		world.clean();
	}
});
