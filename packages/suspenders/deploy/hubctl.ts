#!/usr/bin/env bun
// deploy/hubctl.ts — the hub deployment control surface. Reads the machine-level
// stack config (~/.config/klh/stack.yaml, mode 600 — hubs, ports, connection
// URIs, secret PATHS never values), then materializes deploys from it:
// nothing hub-specific is hardcoded here; undeclared knobs fall through to the
// hub-compose.yaml template defaults. Secrets are minted ON the hub device
// (idempotent, never printed, never transported in the clear — ssh only).
//   bun deploy/hubctl.ts render <hub>   # compose .env → stdout (no secrets)
//   bun deploy/hubctl.ts mint  <hub>    # ensure secrets exist on the hub (0600)
//   bun deploy/hubctl.ts push  <hub>    # stream compose template + .env to the hub
//   bun deploy/hubctl.ts up    <hub>    # docker compose up -d on the hub
//                                     #   (refuses a stale/unpinned hub .env; --force overrides)
//   bun deploy/hubctl.ts status <hub>   # per-service health probes
//   bun deploy/hubctl.ts deploy <hub>   # install-grade one-shot: mint → push → up → status
// Config: KLH_STACK env overrides the stack path (tests).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// stack.yaml is parsed by the ONE reader (W356) — hubctl renders deploys
// from it, coord hubs projects the topology from it
import {
	inQuietHours,
	loadStack,
	STACK_PATH,
	type HubProfile,
	type StackConfig,
} from "../hooks/lib/stack-config.ts";

const COMPOSE_TEMPLATE = join(import.meta.dir, "hub-compose.yaml");

/** Resolve a hub by name, listing what exists on a miss. */
function requireHub(stack: StackConfig, name: string): HubProfile {
	const hub = stack.hubs[name];
	if (!hub) {
		throw new Error(
			`hub "${name}" not in ${STACK_PATH()} — known: ${Object.keys(stack.hubs).join(", ")}`,
		);
	}
	return hub;
}

/** Render the compose .env from the profile — declared knobs only (the
 *  template's own defaults cover everything else; single source of truth). */
function renderEnv(
	hub: HubProfile,
	name: string,
	authRequired?: boolean,
	version?: string,
): string {
	const ref = version;
	if (!ref || ref === "main" || ref === "master")
		throw new Error(
			"hub deploy requires a pinned stack version (reviewed SHA or release tag)",
		);
	const origins = [
		...new Set(
			[hub.repos?.buckle, hub.repos?.suspenders, hub.repos?.belt].filter(
				Boolean,
			),
		),
	];
	if (origins.length > 1)
		throw new Error("hub packages must share one Fleet monorepo origin");
	const origin = origins[0] ?? "https://github.com/klh/fleet.git";
	if (/github\.com[:/]klh\/(?:buckle|suspenders|belt)(?:\.git)?$/.test(origin))
		throw new Error(
			"archived package origin cannot deploy Fleet; configure the monorepo origin",
		);
	// Overlay origin (the private tier): the hub pulls its OWN deployable ref —
	// the 40-hex stack version cannot exist as a ref in a private origin
	// (GitHub GH002 bans sha-named refs); the public base rides the version
	// via the overlay's git-dep pins instead (bun install on the hub).
	const overlay = origin !== "https://github.com/klh/fleet.git";
	if (overlay && !hub.repos?.ref)
		throw new Error(
			"overlay origin needs repos.ref — the hub's own deployable ref (the stack version cannot be a ref in a private origin: GH002)",
		);
	if (!overlay && hub.repos?.ref && hub.repos.ref !== version)
		throw new Error("hub repo ref must match the shared stack version");
	const lines = [`HUB_NAME=${name}`];
	const kv = (key: string, v: unknown): void => {
		if (v !== undefined) lines.push(`${key}=${String(v)}`);
	};
	kv("HUB_BUCKLE_PORT", hub.buckle_port);
	kv("HUB_BUCKLE_BIND", hub.bind);
	kv("HUB_FLEET_REF", overlay ? hub.repos?.ref : ref);
	kv("HUB_FLEET_REPO_URL", origin);
	kv("HUB_BUCKLE_ENV_FILE", hub.secrets?.buckle_root_key);
	if (authRequired !== undefined)
		kv("HUB_BUCKLE_AUTH", authRequired ? "on" : "off");
	kv("HUB_BOARD_PORT", hub.board_port);
	kv("HUB_BOARD_BIND", hub.board_bind);
	kv("HUB_ALLOWED_HOSTS", hub.allowed_hosts?.join(","));
	// W362: peer edge labels — the start-topology as data; hosts/ports/keys
	// resolve at runtime behind the labels (resolveHub chain / stack.yaml).
	kv("HUB_PEERS", hub.peers?.join(","));
	kv("HUB_SERVICES_JSON", hub.services_json);
	kv("HUB_STORE_PORT", hub.store_port);
	kv("HUB_BELT_BIND", hub.belt_bind);
	kv("HUB_BELT_PORT", hub.belt_port);
	// health sidecar ports (W422.10) — compose health hits the SIDECAR
	kv("HUB_BUCKLE_HEALTH_PORT", hub.buckle_health_port);
	kv("HUB_BOARD_HEALTH_PORT", hub.board_health_port);
	kv("HUB_STORE_HEALTH_PORT", hub.store_health_port);
	kv("HUB_BELT_HEALTH_PORT", hub.belt_health_port);
	// synthetic readiness (W467) — the completion leg's verdict port + model
	kv("HUB_BUCKLE_READY_PORT", hub.buckle_ready_port);
	kv("HUB_READY_MODEL", hub.ready_model);
	return `${lines.join("\n")}\n`;
}

/** Run a script on the hub host (or locally when the hub has no ssh target). */
function runOnHub(hub: HubProfile, script: string): string {
	if (hub.deploy?.ssh) {
		return execFileSync("ssh", [hub.deploy.ssh, script], { encoding: "utf8" });
	}
	return execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
}

/** Copy a file to the hub host (scp legacy protocol — Synology sshd has no
 *  SFTP subsystem; the hub's deploy.dir must exist). */
function copyToHub(hub: HubProfile, src: string, dest: string): void {
	if (hub.deploy?.ssh) {
		execFileSync("scp", ["-O", "-q", src, `${hub.deploy.ssh}:${dest}`]);
		return;
	}
	writeFileSync(dest, readFileSync(src));
}

const MINT_SCRIPT = [
	"umask 077",
	"F=$1",
	'mkdir -p "$(dirname "$F")"',
	'[ -s "$F" ] && { echo have; exit 0; }',
	"if command -v openssl >/dev/null 2>&1; then",
	"  K=$(openssl rand -hex 32)",
	"else",
	'  K=$(docker run --rm oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 bun -e \'console.log([...new Uint8Array(crypto.getRandomValues(new Uint8Array(32)))].map(b=>b.toString(16).padStart(2,"0")).join(""))\')',
	"fi",
	'printf \'BUCKLE_ROOT_KEY=%s\\n\' "$K" > "$F"',
	"echo minted",
].join("\n");

/** Ensure the buckle break-glass root key exists ON the hub device (0600,
 *  idempotent, key material never printed or transported in the clear). */
function mintRootKey(hub: HubProfile): void {
	const target = hub.secrets?.buckle_root_key;
	if (!target) {
		console.log(`= no secrets declared for this hub — nothing to mint`);
		return;
	}
	const out = runOnHub(
		hub,
		`/bin/sh -c '${MINT_SCRIPT.replace(/'/g, `'\\''`)}' sh ${JSON.stringify(target)}`.replace(
			"sh '' ",
			"",
		),
	);
	console.log(`+ ${target} (${out.trim()})`);
}

/** Push the compose template + rendered .env to the hub's deploy dir. */
function pushConfig(
	hub: HubProfile,
	name: string,
	authRequired?: boolean,
	version?: string,
): void {
	if (!existsSync(COMPOSE_TEMPLATE)) {
		throw new Error(`compose template missing: ${COMPOSE_TEMPLATE}`);
	}
	const envText = renderEnv(hub, name, authRequired, version);
	const dir = requireDir(hub);
	const envPath = `${dir}/.env`;
	// ensure the deploy dir on both paths before any file lands
	if (hub.deploy?.ssh) {
		execFileSync("ssh", [hub.deploy.ssh, `mkdir -p ${JSON.stringify(dir)}`]);
	} else {
		mkdirSync(dir, { recursive: true });
	}
	copyToHub(hub, COMPOSE_TEMPLATE, `${dir}/hub-compose.yaml`);
	if (hub.deploy?.ssh) {
		execFileSync(
			"ssh",
			[hub.deploy.ssh, `/bin/sh -c 'cat > ${JSON.stringify(envPath)}'`],
			{ input: envText },
		);
		return;
	}
	writeFileSync(envPath, envText);
}

/** Where hub-compose.yaml + .env live on the hub — declared, never defaulted. */
function requireDir(hub: HubProfile): string {
	const dir = hub.deploy?.dir;
	if (!dir) {
		throw new Error(
			`hub has no deploy.dir in ${STACK_PATH()} — declare where hub-compose.yaml + .env live on the hub`,
		);
	}
	return dir;
}

/** docker compose up -d on the hub. */
function composeUp(hub: HubProfile): void {
	const dir = requireDir(hub);
	const docker = hub.deploy?.docker ?? "docker";
	console.log(
		runOnHub(
			hub,
			`${docker} compose -f ${JSON.stringify(`${dir}/hub-compose.yaml`)} --project-directory ${JSON.stringify(dir)} up -d`,
		).trim(),
	);
}

/** The HUB_FLEET_REF a hub's deployed .env pins — null when there is none
 *  (never-pushed hub, or a stale pre-pin env like the W422.6 poison). */
function hubEnvRef(hub: HubProfile, dir: string): string | null {
	try {
		if (!hub.deploy?.ssh) {
			const path = `${dir}/.env`;
			if (!existsSync(path)) return null;
			return (
				/^HUB_FLEET_REF=(.*)$/m.exec(readFileSync(path, "utf8"))?.[1].trim() ??
				null
			);
		}
		const text = runOnHub(
			hub,
			`cat ${JSON.stringify(`${dir}/.env`)} 2>/dev/null || true`,
		);
		return /^HUB_FLEET_REF=(.*)$/m.exec(text)?.[1].trim() ?? null;
	} catch {
		return null;
	}
}

/** W422.6.2: `up` honors the same pinned-version gate deploy enforces — it
 *  used to compose-up whatever .env sat on the hub (the desktop hub ran a
 *  stale pre-pin env and crash-looped every container). A missing or
 *  mismatched HUB_FLEET_REF is refused; --force proceeds with a warning.
 *  `up` never re-renders the env: staleness is fixed by `hubctl push` (the
 *  write surface), not a silent write from up. */
function upHub(
	hub: HubProfile,
	name: string,
	version: string | undefined,
	force: boolean,
): void {
	const dir = requireDir(hub);
	const ref = hubEnvRef(hub, dir);
	if (ref !== null && version !== undefined && ref === version) {
		composeUp(hub);
		return;
	}
	const reason =
		ref === null
			? `no HUB_FLEET_REF in ${dir}/.env — re-render: hubctl push ${name}`
			: version === undefined
				? `hub .env pins ${ref} but stack.yaml has no pinned version — set version: then hubctl push ${name}`
				: `hub .env pins ${ref} but stack.yaml pins ${version} — re-render: hubctl push ${name}`;
	if (!force)
		throw new Error(
			`hubctl up refused: ${reason} (override: hubctl up ${name} --force)`,
		);
	console.log(`! up --force: proceeding on a stale env — ${reason}`);
	composeUp(hub);
}

/** Probe every service port; exit non-zero when any probe fails. */
function status(hub: HubProfile): number {
	const docker = hub.deploy?.docker ?? "docker";
	const dir = requireDir(hub);
	const ps = runOnHub(
		hub,
		`${docker} compose -f ${JSON.stringify(`${dir}/hub-compose.yaml`)} --project-directory ${JSON.stringify(dir)} ps --format json`,
	).trim();
	let failed = 0;
	for (const line of ps.split("\n").filter((l) => l.startsWith("{"))) {
		try {
			const row = JSON.parse(line) as {
				Service?: string;
				State?: string;
				Health?: string;
			};
			const svc = row.Service ?? "?";
			const ok =
				row.State === "running" && (!row.Health || row.Health === "healthy");
			if (!ok) failed++;
			console.log(
				`${ok ? "✓" : "✗"} ${svc}: ${row.State ?? "?"}${row.Health ? ` (${row.Health})` : ""}`,
			);
		} catch {
			failed++;
		}
	}
	const probes: Array<[string, number, string]> = [
		["buckle-health", hub.buckle_health_port ?? 4112, "/healthz"],
		["buckle-ready", hub.buckle_ready_port ?? 4113, "/healthz"],
		["board-health", hub.board_health_port ?? 7800, "/healthz"],
		["store-health", hub.store_health_port ?? 7794, "/healthz"],
		["belt-health", hub.belt_health_port ?? 7790, "/healthz"],
	];
	for (const [svc, port, path] of probes) {
		if (!port) continue;
		const code = runOnHub(
			hub,
			`curl --max-time 5 -so /dev/null -w '%{http_code}' http://127.0.0.1:${port}${path} || true`,
		).trim();
		const ok = code === "200";
		if (!ok) failed++;
		console.log(
			`${ok ? "✓" : "✗"} ${svc} :${port}${path} → ${code || "no answer"}`,
		);
	}
	// W443: artifact diagnostics — the runtime + embedded SQLite of the
	// RUNNING container (buckle-hub owns the WAL ledger), never the host.
	// Informational: health gates the exit code; CI gates the version.
	runtimeReport(hub, docker, dir);
	return failed;
}

/** Exec deploy/runtime-info.ts inside buckle-hub and print the verdict. */
function runtimeReport(hub: HubProfile, docker: string, dir: string): void {
	const compose = `docker compose -f ${JSON.stringify(`${dir}/hub-compose.yaml`)} --project-directory ${JSON.stringify(dir)}`;
	try {
		const out = runOnHub(
			hub,
			`${compose} exec -T buckle-hub bun /src/fleet/packages/suspenders/deploy/runtime-info.ts --json 2>&1 || true`,
		);
		const line = [...out.split("\n")].reverse().find((l) => l.startsWith("{"));
		if (line) {
			const r = JSON.parse(line) as {
				bun: string;
				sqlite: string;
				verified: boolean;
				reason: string;
			};
			console.log(
				`· runtime: bun ${r.bun} · SQLite ${r.sqlite} — ${r.verified ? "WAL-reset fix verified" : "WAL-reset fix UNVERIFIED"} (${r.reason})`,
			);
			return;
		}
	} catch {
		// degrade — diagnostics, not a health gate
	}
	console.log("· runtime: unknown (buckle-hub container did not answer)");
}

/** Install-grade hub deploy (W363): the README chain in one idempotent
 *  command — mint → push → up, stop on first failure, then the outside-process
 *  probes gate the exit code (a deploy is done when health says so). */
function deployHub(
	hub: HubProfile,
	name: string,
	authRequired?: boolean,
	version?: string,
): void {
	// Validate the immutable source before minting or copying anything.
	renderEnv(hub, name, authRequired, version);
	mintRootKey(hub);
	pushConfig(hub, name, authRequired, version);
	composeUp(hub);
	const failed = status(hub);
	if (failed > 0) {
		console.log(
			`deploy: ${name} — ${failed} probe(s) failed after up (services may still be starting; re-check: hubctl status ${name})`,
		);
		process.exit(1);
	}
	console.log(`deploy: ${name} all healthy`);
}

function main(): void {
	const [verb, hubName, ...flags] = process.argv.slice(2);
	const force = flags.includes("--force");
	const stack = loadStack();
	const authRequired = stack.auth?.required;
	if (!hubName || verb === "--help" || verb === "-h") {
		console.log(
			"usage: hubctl <render|mint|push|up|status|deploy> <hub> — config: ~/.config/klh/stack.yaml\n" +
				"       up accepts --force: proceed on a stale/unpinned hub .env (refused by default)",
		);
		process.exit(hubName ? 0 : 2);
	}
	const hub = requireHub(stack, hubName);
	if (verb === "status") {
		// W483: inside the hub's quiet-hours window the hub is EXPECTED down
		// (NAS nightly poweroff) — probing would only page dead-letter noise.
		if (inQuietHours(hub)) {
			console.log(
				`quiet hours ${hub.quiet_hours} — ${hubName} expected down; probes suppressed`,
			);
			process.exit(0);
		}
		const failed = status(hub);
		console.log(failed === 0 ? "all healthy" : `${failed} probe(s) failed`);
		process.exit(failed === 0 ? 0 : 1);
	}
	switch (verb) {
		case "render":
			console.log(renderEnv(hub, hubName, authRequired, stack.version));
			return;
		case "mint":
			mintRootKey(hub);
			return;
		case "push":
			pushConfig(hub, hubName, authRequired, stack.version);
			return;
		case "up":
			upHub(hub, hubName, stack.version, force);
			return;
		case "deploy":
			deployHub(hub, hubName, authRequired, stack.version);
			return;
		default:
			console.log(
				`hubctl: unknown verb "${verb}" — render|mint|push|up|status|deploy`,
			);
			process.exit(2);
	}
}

main();
