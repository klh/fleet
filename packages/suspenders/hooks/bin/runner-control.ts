#!/usr/bin/env bun
import { settings } from "@klh/settings";
import { runnerHostConfig } from "../lib/runners/service/config.ts";
import { loadDesktopRuntimeConfig } from "../lib/runners/service/desktop-config.ts";
import {
	checkDesktopImage,
	checkDesktopMintAuthority,
	checkRunnerDockerLimits,
} from "../lib/runners/service/desktop-preflight.ts";
import { desktopRuntime } from "../lib/runners/service/desktop-runtime.ts";
import { runRunnerService } from "../lib/runners/service/process.ts";
import { readRunnerProfiles } from "../lib/runners/service/profiles.ts";

if (process.argv.length === 2) {
	try {
		const config = settings({ mode: "service" }).runner;
		await runRunnerService(
			await desktopRuntime(config, runnerHostConfig(config).stateDir),
		);
		process.exit(0);
	} catch {
		console.error("runner.start_failed");
		process.exit(1);
	}
} else if (process.argv.length !== 3 || process.argv[2] !== "--check") {
	console.error("usage: runner-control --check");
	process.exitCode = 2;
} else {
	try {
		const config = settings({ mode: "service" }).runner;
		const host = runnerHostConfig(config);
		readRunnerProfiles(host.profilesFile);
		const desktop = await loadDesktopRuntimeConfig(config);
		const [imageId] = await Promise.all([
			checkDesktopImage(desktop.image),
			checkDesktopMintAuthority(desktop.baseUrl, desktop.adminKey),
			checkRunnerDockerLimits(),
		]);
		console.log(JSON.stringify({ preflight: "passed", imageId }));
	} catch (error) {
		const code =
			error instanceof Error && /^runner\.[a-z_]+$/.test(error.message)
				? error.message
				: "runner.preflight_failed";
		console.error(code);
		process.exitCode = 1;
	}
}
