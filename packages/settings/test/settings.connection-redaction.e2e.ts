import { expect, test } from "@playwright/test";
import { chmodSync, readFileSync } from "node:fs";
import { runSettingsCli } from "../src/settings.cli.ts";
import { resetSettingsCache } from "../src/settings.reader.ts";
import { envRestore, envSnapshot, scratchSettingsHome } from "./helpers.ts";

test("CLI refuses a document above the private reader byte cap without replacing it", () => {
	const world = scratchSettingsHome(),
		saved = envSnapshot();
	try {
		process.env.KLH_SETTINGS = world.file;
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
		const original = readFileSync(world.file, "utf8");
		expect(
			runSettingsCli(
				["set", "postures", JSON.stringify({ payload: "x".repeat(1048576) })],
				{ out: () => {}, err: () => {} },
			),
		).toBe(1);
		expect(readFileSync(world.file, "utf8")).toBe(original);
	} finally {
		resetSettingsCache();
		envRestore(saved);
		world.clean();
	}
});

test("show/get/origin never expose private credential values or parse snippets", () => {
	const world = scratchSettingsHome(),
		saved = envSnapshot();
	const sentinel = "fixture-private-sentinel-value";
	try {
		process.env.KLH_SETTINGS = world.file;
		world.setFile({ postures: { credentials: { api_key: sentinel } } });
		chmodSync(world.file, 0o600);
		expect(
			runSettingsCli(
				["set", "postures.credentials.api_key", JSON.stringify(sentinel)],
				{ out: () => {}, err: () => {} },
			),
		).toBe(0);
		expect(
			JSON.parse(readFileSync(world.file, "utf8")).postures.credentials.api_key,
		).toBe(sentinel);
		for (const args of [
			["show"],
			["show", "--effective"],
			["show", "--origin"],
			["get", "postures"],
			["get", "postures.credentials.api_key"],
		]) {
			let output = "";
			resetSettingsCache();
			expect(
				runSettingsCli(args, {
					out: (s) => {
						output += s;
					},
					err: (s) => {
						output += s;
					},
				}),
			).toBe(0);
			expect(output).not.toContain(sentinel);
		}
		world.writeRaw(`{"postures":{"api_key":"${sentinel}"} broken}`);
		let diagnostics = "";
		expect(
			runSettingsCli(["validate"], {
				out: (s) => {
					diagnostics += s;
				},
				err: (s) => {
					diagnostics += s;
				},
			}),
		).toBe(1);
		expect(diagnostics).not.toContain(sentinel);
	} finally {
		resetSettingsCache();
		envRestore(saved);
		world.clean();
	}
});
