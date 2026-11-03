// hooks/bin/launchd-launcher.ts — W2470.2: the ONE generic launchd launcher.
// A unit's EnvironmentVariables live in the machine settings' fleet_loop
// block (launchd_env.<service>), NOT in the plist; this launcher reads the
// conf at START time, applies the row over the inherited environment, and
// execs the real entry — so an env change is a conf edit, never a launchd
// reload. The plist keeps its own ProgramArguments/paths (launchd never
// reads fleet conf — the manifest stays the launch contract); only the
// VALUES centralized.
//
// run:  bun launchd-launcher.ts <service> -- <bunEntry> [args…]
//       (renderDarwin emits exactly this argv when a spec carries confEnv)
//
// Fail-loud posture: an unknown service (no conf row) execs with the
// inherited environment — the unit is env-less by construction, so there
// is nothing to fall back to and the service surfaces its own misconfig;
// a MALFORMED settings file fails closed (exit 1, diagnostic to stderr)
// rather than silently running with the wrong environment. Secrets never
// print: only key names ride the diagnostic lines.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSettings } from "@klh/settings";

const [service, sep, entry, ...args] = process.argv.slice(2);
if (
	service === undefined ||
	sep !== "--" ||
	entry === undefined ||
	process.argv[3] !== "--"
) {
	process.stderr.write(
		"usage: launchd-launcher.ts <service> -- <bunEntry> [args…]\n",
	);
	process.exit(64);
}

let envRow: Record<string, string> | undefined;
try {
	const resolved = resolveSettings({ mode: "service", quiet: true });
	envRow = resolved.settings.fleet_loop.launchd_env[service];
} catch (error) {
	// fail closed: a malformed settings.json must not silently run the
	// service under an empty/stale environment
	process.stderr.write(
		`launchd-launcher[${service}]: settings unreadable — refusing: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
}

// Baseline plumbing env (the exact set the retired per-plist dicts carried):
// HOME + a supervision PATH. The conf row wins over the baseline; an
// inherited launchd value wins over neither except where the baseline fills
// a gap (launchd's sparse default PATH would clobber it otherwise).
const home = process.env.HOME ?? homedir();
const baseline: Record<string, string> = {
	HOME: home,
	PATH: [
		`${home}/.local/bin`,
		`${home}/.bun/bin`,
		"/opt/homebrew/bin",
		"/usr/local/bin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	].join(":"),
};
// Bun reads NODE_EXTRA_CA_CERTS at process start (renderDarwin used to add
// the local Caddy CA at render time for services that talk to .local
// fronts) — resolved here, at start time, for every launched service.
const localCa =
	process.env.KLH_LOCAL_CA_FILE ??
	join(
		home,
		"Library",
		"Application Support",
		"Caddy",
		"pki",
		"authorities",
		"local",
		"root.crt",
	);
if (existsSync(localCa)) baseline.NODE_EXTRA_CA_CERTS = localCa;

const child = Bun.spawn([process.execPath, entry, ...args], {
	env: { ...process.env, ...baseline, ...envRow },
	stdout: "inherit",
	stderr: "inherit",
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
const code = await child.exited;
process.exit(code);
