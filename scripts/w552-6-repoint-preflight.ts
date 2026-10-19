// W552.6: re-point take-7-single config paths from /tmp staging to the real kit
// location, then run the check-one-request preflight from the .fleet kit.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const kit = "/Volumes/Sensitive/github/klh/fleet/.fleet/demos/ikea-recording";
const take = join(kit, "take-7-single");

// 1. repo-policy.json: keyFile must live in the take dir, not the staging dir
const configPath = join(take, "repo-policy.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.hubs?.[0]?.keyFile?.startsWith("/private/tmp/")) {
	config.hubs[0].keyFile = join(take, "simulation-policy-key");
	writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// 2. readiness.json: fixture/project/baseline describe the take dir itself
const readinessPath = join(take, "readiness.json");
const readiness = JSON.parse(readFileSync(readinessPath, "utf8"));
if (readiness.fixture?.startsWith("/private/tmp/")) {
	readiness.fixture = join(take, "ikea-repo");
	readiness.project = join(take, "ikea-repo", ".git");
	readiness.stagedVia = "tmp/w552-6-kit (headless lane; NAS fetch 2026-10-19)";
	writeFileSync(readinessPath, JSON.stringify(readiness, null, 2), {
		mode: 0o600,
	});
}

// 3. mother-settings.json: the policy config env var also baked the staging path
const settingsPath = join(take, "mother-settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
if (settings.env?.SUSPENDERS_REPO_POLICY_CONFIG?.startsWith("/private/tmp/")) {
	settings.env.SUSPENDERS_REPO_POLICY_CONFIG = configPath;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), {
		mode: 0o600,
	});
}

// 4. perms sanity on the secret surfaces
for (const f of [
	"repo-policy.json",
	"simulation-policy-key",
	"mother-settings.json",
]) {
	const m = statSync(join(take, f)).mode & 0o777;
	if (m !== 0o600) throw Error(`${f} mode ${m.toString(8)} != 600`);
}

// 5. preflight: check-one-request from the REAL kit location
const env = { ...process.env, FLEET_DEMO_TAKE: "take-7-single" };
const chk = Bun.spawnSync(
	["bun", join(kit, "live-kit.ts"), "check-one-request"],
	{ env, stdout: "pipe", stderr: "pipe", timeout: 60000 },
);
console.log("check exit", chk.exitCode);
const out = chk.stdout.toString().trim();
if (chk.exitCode !== 0) {
	console.error(chk.stderr.toString().slice(-1500));
	process.exit(chk.exitCode);
}
const parsed = JSON.parse(out);
console.log(
	JSON.stringify({
		ok: parsed.ok,
		sid: parsed.sid,
		project: parsed.project,
		launchesClaude: parsed.launchesClaude,
		requestChars: parsed.request.length,
	}),
);
