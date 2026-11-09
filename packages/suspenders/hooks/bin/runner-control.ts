#!/usr/bin/env bun
import { settings } from "@klh/settings";
import { loadDesktopRuntimeConfig } from "../lib/runners/service/desktop-config.ts";
import { checkDesktopImage } from "../lib/runners/service/desktop-preflight.ts";
import { runnerHostConfig } from "../lib/runners/service/config.ts";

if (process.argv.length !== 3 || process.argv[2] !== "--check") {
	console.error("usage: runner-control --check");
	process.exitCode = 2;
} else {
	try {
		const config = settings({ mode: "service" }).runner;
		runnerHostConfig(config);
		const desktop = await loadDesktopRuntimeConfig(config);
		const imageId = await checkDesktopImage(desktop.image);
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
