#!/usr/bin/env bun
// runner-control-health.ts — W2880: the runner-control service's independent
// health probe sidecar (owner law 2026-10-05). Staged as its OWN launchd
// unit (services.yaml runner-control-health) — OUTSIDE the served process:
// it polls the service's unauthenticated /v1/runner/health face over the
// network and serves the verdict on control-port+1 (:7811), so a wedged
// runner-control process cannot paint itself healthy. One implementation:
// spawns the ONE tracked probe sidecar source (deploy/healthcheck/probe.ts).
// Optional --every/--timeout/--misses overrides exist for witnesses only;
// the staged unit rides the probe defaults.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settings } from "@klh/settings";

const runner = settings({ mode: "service" }).runner;
const control = new URL(runner.control_url);
const flag = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	if (i === -1) return undefined;
	return process.argv[i + 1];
};
const overrides: string[] = [];
for (const name of ["--every", "--timeout", "--misses"]) {
	const value = flag(name);
	if (value !== undefined) overrides.push(name, value);
}
const probeSource = fileURLToPath(
	new URL("../../deploy/healthcheck/probe.ts", import.meta.url),
);
if (!existsSync(probeSource)) {
	console.error(`runner-control-health: probe source missing: ${probeSource}`);
	process.exit(2);
}
const child = Bun.spawn(
	[
		process.execPath,
		probeSource,
		"--target",
		`${control.origin}/v1/runner/health`,
		"--listen",
		String(Number(control.port) + 1),
		...overrides,
	],
	{ stdout: "inherit", stderr: "inherit", stdin: "ignore" },
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, () => child.kill(signal));
await child.exited;
