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
//   bun deploy/hubctl.ts manifest <hub> [--out <dir>]  # W698: release manifest + SBOM
//   bun deploy/hubctl.ts exec <hub> <cmd...>   # W484.1.1: allowlisted read-only
//                                             #   probes over the ssh path
//   bun deploy/hubctl.ts mint-lane-key <hub> --sid <sid> [--ttl <s>]
//                                     # W484.1.1: mint a short-lived bksk_ lane
//                                     #   key ON the hub — the root credential
//                                     #   never leaves the device
//   bun deploy/hubctl.ts mint-service-key <hub> --name <name> --out <keyfile>
//                                     # W1124.15: mint a PERSISTENT proxy-only
//                                     #   service credential (no expiry) for
//                                     #   spoke/persistent hub links — audited,
//                                     #   distinct from expiring lane keys; the
//                                     #   raw key lands in --out (0600), stdout
//                                     #   carries metadata only
//   bun deploy/hubctl.ts verify-key <hub> --file <path>
//                                     # W1124.15: verify a configured cross-hub
//                                     #   key against the hub's verify API —
//                                     #   exit 1 with the hub's actual
//                                     #   expired/revoked code on a dead key
// Config: KLH_STACK env overrides the stack path (tests).

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
// stack.yaml is parsed by the ONE reader (W356) — hubctl renders deploys
// from it, coord hubs projects the topology from it
import {
	type HubProfile,
	inQuietHours,
	loadStack,
	STACK_PATH,
	type StackConfig,
} from "../hooks/lib/stack-config.ts";
import { composeUpArgv, sshOpts } from "./hub-remote.ts";
import { mergedHubUpstreams } from "./openrouter-free.ts";
import { mergeZaiHubUpstreams } from "./zai-catalog.ts";
import { renderHubPolicy } from "./hub-policy.ts";
import {
	mintServiceKey,
	runMintOnHub,
	verifyConfiguredServiceKey as serviceKeyVerdict,
	verifyKeyFile,
	type ServiceKeyRunner,
} from "./service-key.ts";
import { traceTunnelVerb } from "./trace-tunnel.ts";

import {
	buildRelease,
	checkoutSha,
	schemaVersions,
	writeRelease,
} from "./release-manifest.ts";

const COMPOSE_TEMPLATE = join(import.meta.dir, "hub-compose.yaml");

type GateRun = () => {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
};

/** Static gate before a hub starts: a down target is normal on first deploy.
 * The target's outside-process sidecars are checked by deploy/status after up. */
export function assertHubActivationPreflight(
	verb: string,
	run: GateRun = () =>
		spawnSync(
			process.execPath,
			[join(import.meta.dir, "../scripts/route-preflight.ts"), "--static"],
			{ encoding: "utf8", timeout: 10_000 },
		),
): void {
	if (verb !== "up" && verb !== "deploy") return;
	const result = run();
	let report: {
		ok?: boolean;
		mode?: string;
		findings?: unknown[];
		drills?: Array<{ ok?: boolean }>;
	};
	try {
		report = JSON.parse(result.stdout);
	} catch {
		throw new Error(
			`hubctl ${verb} refused: route preflight did not return a valid receipt (${result.error?.message ?? (result.stderr.trim() || "no output")})`,
		);
	}
	if (
		result.status !== 0 ||
		report.ok !== true ||
		report.mode !== "static" ||
		!Array.isArray(report.findings) ||
		report.findings.length > 0 ||
		!Array.isArray(report.drills) ||
		report.drills.length === 0 ||
		report.drills.some((drill) => drill.ok !== true)
	)
		throw new Error(
			`hubctl ${verb} refused: route preflight failed (${report.findings?.length ?? "?"} graph findings, ${report.drills?.length ?? 0} drills; run route-preflight --static for details)`,
		);
}

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

/** A local hub must not publish over an existing .local service. The registry
 * is machine-owned, so this check follows the operator's actual front. */
function assertLocalPortReservations(hub: HubProfile, name: string): void {
	if (hub.deploy?.ssh) return;
	const path = join(
		process.env.HOME ?? homedir(),
		".local/state/klh-local/registry.json",
	);
	if (!existsSync(path)) return;
	const services = JSON.parse(readFileSync(path, "utf8")) as Array<{
		name?: string;
		port?: number;
	}>;
	if (!Array.isArray(services))
		throw new Error(`${path} is not a service list`);
	for (const [kind, port] of [
		["buckle", hub.buckle_port],
		["board", hub.board_port],
		["store", hub.store_port],
		["belt", hub.belt_port],
	] as const) {
		if (!port) continue;
		const conflict = services.find((service) => Number(service.port) === port);
		if (conflict)
			throw new Error(
				`${name} ${kind}_port ${port} conflicts with ${conflict.name ?? "a registered .local service"}; choose another port in stack.yaml`,
			);
	}
}

/** Render the compose .env from the profile — declared knobs only (the
 *  template's own defaults cover everything else; single source of truth). */
function renderEnv(
	hub: HubProfile,
	name: string,
	auth?: StackConfig["auth"],
	version?: string,
): string {
	assertLocalPortReservations(hub, name);
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
	kv("HUB_FLEET_SRC", hub.repos?.src);
	kv("HUB_BUCKLE_ENV_FILE", hub.secrets?.buckle_root_key);
	if (auth?.required !== undefined)
		kv("HUB_BUCKLE_AUTH", auth.required ? "on" : "off");
	// W372: the auth.oidc/auth.tokens blocks materialize as env — Entra-ready
	// by config (values live ONLY in the machine stack.yaml; partial blocks
	// fail closed at render, a hub never ships a half-declared posture).
	if (auth?.tokens?.ttlHours !== undefined)
		kv("HUB_BUCKLE_AUTH_TTL_HOURS", auth.tokens.ttlHours);
	if (auth?.oidc) {
		const o = auth.oidc;
		if (!o.issuer || !o.audience)
			throw new Error(
				"auth.oidc requires issuer + audience (Entra values live in the machine stack.yaml, never in the repo)",
			);
		kv("HUB_BUCKLE_OIDC_ENFORCED", o.enforced === false ? "off" : "on");
		kv("HUB_BUCKLE_OIDC_ISSUER", o.issuer);
		kv("HUB_BUCKLE_OIDC_JWKS_URI", o.jwksUri);
		kv("HUB_BUCKLE_OIDC_AUDIENCE", o.audience);
		kv("HUB_BUCKLE_OIDC_REQUIRED_SCOPE", o.requiredScope);
	}
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
	if (hub.belt_model) {
		const upstream = new URL(hub.belt_model.upstream);
		if (
			!["http:", "https:"].includes(upstream.protocol) ||
			upstream.username ||
			upstream.password
		)
			throw new Error(
				"belt_model.upstream must be an HTTP URL without credentials",
			);
		kv("COMPOSE_PROFILES", "belt-model");
		kv("HUB_BELT_MODEL_PORT", hub.belt_model.port);
		kv("HUB_BELT_MODEL_HEALTH_PORT", hub.belt_model.health_port);
		kv("HUB_BELT_MODEL_UPSTREAM", upstream.href.replace(/\/$/, ""));
	}
	// health sidecar ports (W422.10) — compose health hits the SIDECAR
	kv("HUB_BUCKLE_HEALTH_PORT", hub.buckle_health_port);
	kv("HUB_BOARD_HEALTH_PORT", hub.board_health_port);
	kv("HUB_STORE_HEALTH_PORT", hub.store_health_port);
	kv("HUB_BELT_HEALTH_PORT", hub.belt_health_port);
	// W763 hub model store — face + health sidecar ports
	kv("HUB_MODEL_STORE_PORT", hub.model_store_port);
	kv("HUB_MODEL_STORE_HEALTH_PORT", hub.model_store_health_port);
	// synthetic readiness (W467) — the completion leg's verdict port + model
	kv("HUB_BUCKLE_READY_PORT", hub.buckle_ready_port);
	kv("HUB_READY_MODEL", hub.ready_model);
	// W688.7.1: enterprise entrypoint + private-network ladder egress hosts
	kv("HUB_BUCKLE_ENTRY", hub.buckle_entry);
	kv("HUB_HTTP_UPSTREAM_HOSTS", hub.http_upstream_hosts?.join(","));
	// W688.3: overlay code-loader knobs (env plumbing only, config-over-code;
	// unset = solo posture — the loader treats unset exactly as before)
	kv("HUB_KLH_OVERLAY_DIR", hub.overlay?.dir);
	kv("HUB_KLH_OVERLAY_SHA256", hub.overlay?.sha256);
	kv("HUB_KLH_OVERLAY_ALLOW", hub.overlay?.allow);
	// W854: mDNS advertisement — what _klh-hub._tcp advertises (the
	// announcer falls through to the template defaults for undeclared knobs;
	// advertised port defaults to HUB_BUCKLE_PORT in the template)
	kv("HUB_MDNS_PORT", hub.mdns?.port);
	kv("HUB_MDNS_ADDR", hub.mdns?.addr);
	kv("HUB_MDNS_HOSTNAME", hub.mdns?.hostname);
	kv("HUB_MDNS_INTERVAL_MS", hub.mdns?.interval_ms);
	kv("HUB_MDNS_HEALTH_PORT", hub.mdns?.health_port);
	kv("HUB_MDNS_SIDECAR_PORT", hub.mdns?.sidecar_port);
	return `${lines.join("\n")}\n`;
}

/** Render is a diagnostic surface. A private Git origin may carry userinfo;
 *  the deploy file keeps it under mode 0600, but stdout never exposes it. */
function redactedRender(envText: string): string {
	return envText.replace(/^HUB_FLEET_REPO_URL=(.+)$/m, (line, raw: string) => {
		try {
			const url = new URL(raw);
			if (!url.username && !url.password) return line;
			url.username = "";
			url.password = "";
			return `HUB_FLEET_REPO_URL=${url.toString()} # credentials redacted`;
		} catch {
			return "HUB_FLEET_REPO_URL=<redacted>";
		}
	});
}

/** W688.7.1: the hub's upstream ladder file — stack.yaml `upstreams:` in
 *  buckle's upstreams.yaml shape. W1123 hub identity: always stamped
 *  `inherit_defaults: false` (fail-forward, no operator escape — an opt-in
 *  would re-import the committed Mac local-swarm :890x onto a remote hub).
 *  A Docker/remote hub exposes ONLY its configured + generated groups; empty
 *  groups = an empty pool, not a silent inheritance. The local Mac spoke
 *  keeps merge-over-base through its own UNFLAGGED override file. Always
 *  rendered: compose mounts it. */
function renderUpstreams(hub: HubProfile): string {
	return stringify({
		version: 1,
		inherit_defaults: false,
		groups: mergeZaiHubUpstreams(hub, mergedHubUpstreams(hub)),
	});
}

/** W983: the hub's Buckle owner prefs in loadPrefs' exact shape (buckle
 *  src/policy.ts) — always rendered (compose mounts it; undeclared = the
 *  conservative defaults, cloud closed). */
function renderBucklePrefs(hub: HubProfile): string {
	return `${JSON.stringify({
		allow_cloud: hub.buckle_prefs?.allow_cloud === true,
		cost_speed: hub.buckle_prefs?.cost_speed ?? "balanced",
	})}\n`;
}

/** W688.7.1: script run ON the hub device — builds the 0600 upstream.env
 *  from `NAME=/path/to/keyfile` args (value read there, never echoed). No
 *  keys declared = an empty file (compose env_file stays valid). */
const UPSTREAM_ENV_SCRIPT = [
	"umask 077",
	'OUT="$1"; shift',
	': > "$OUT.tmp"',
	'for pair in "$@"; do',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: sh parameter expansion in a generated sh script
	'  name="${pair%%=*}"; path="${pair#*=}"',
	'  [ -s "$path" ] || { echo "missing key file for $name" >&2; rm -f "$OUT.tmp"; exit 1; }',
	'  printf \'%s=%s\\n\' "$name" "$(tr -d \'\\r\\n\' < "$path")" >> "$OUT.tmp"',
	"done",
	'mv "$OUT.tmp" "$OUT"',
].join("\n");

// W371: ssh flags + the compose-up argv now live in deploy/hub-remote.ts —
// shared with belt's hub heal, which spawns the same argv (no duplicate
// quoting/flag logic across packages).

/** Run a script on the hub (or locally when the hub has no ssh target).
 *  Extra execFileSync opts (e.g. a bounded timeout) ride through. */
function runOnHub(
	hub: HubProfile,
	script: string,
	opts?: Parameters<typeof execFileSync>[2],
): string {
	if (hub.deploy?.ssh) {
		return execFileSync("ssh", [...sshOpts(hub), hub.deploy.ssh, script], {
			encoding: "utf8",
			...opts,
		});
	}
	return execFileSync("/bin/sh", ["-c", script], {
		encoding: "utf8",
		...opts,
	});
}

/** runOnHub with the exec leg bounded (W671): null when the hub cannot be
 *  reached (ssh down, local exec failed) — callers degrade to unreachable
 *  verdicts instead of dying on the throw. */
function tryRunOnHub(hub: HubProfile, script: string): string | null {
	try {
		return runOnHub(hub, script);
	} catch {
		return null;
	}
}

/** The service-key module's injected hub exec face — hubctl's own runOnHub
 *  (ssh when the hub declares it, local /bin/sh otherwise). */
export const serviceKeyRunner: ServiceKeyRunner = runOnHub;

/** Copy a file to the hub host (scp legacy protocol — Synology sshd has no
 *  SFTP subsystem; the hub's deploy.dir must exist). */
function copyToHub(hub: HubProfile, src: string, dest: string): void {
	if (hub.deploy?.ssh) {
		execFileSync("scp", [
			"-O",
			"-q",
			...sshOpts(hub),
			src,
			`${hub.deploy.ssh}:${dest}`,
		]);
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

/** W688.7.1: materialize `<dir>/upstream.env` ON the hub (compose env_file). */
function pushUpstreamEnv(hub: HubProfile, dir: string): void {
	const pairs = Object.entries(hub.secrets?.upstream_keys ?? {}).map(
		([name, path]) => `${name}=${path}`,
	);
	const quote = (a: string): string => `'${a.replace(/'/g, `'\\''`)}'`;
	const args = [`${dir}/upstream.env`, ...pairs].map(quote).join(" ");
	runOnHub(hub, `/bin/sh -c ${quote(UPSTREAM_ENV_SCRIPT)} sh ${args}`);
}

/** Write the required policy before either fresh activation or reload. */
function pushGatewayPolicy(hub: HubProfile, dir: string): void {
	// Materialize policy beside the ladder: defaults preserved, overrides validated.
	const policyText = renderHubPolicy(
		readFileSync(
			join(import.meta.dir, "../../buckle/routing-policy.yaml"),
			"utf8",
		),
		hub.buckle_gateway,
	);
	if (hub.deploy?.ssh) {
		runOnHub(
			hub,
			`umask 077; cat > ${JSON.stringify(`${dir}/routing-policy.hub.yaml`)}`,
			{ input: policyText },
		);
	} else {
		writeFileSync(`${dir}/routing-policy.hub.yaml`, policyText, {
			mode: 0o600,
		});
		chmodSync(`${dir}/routing-policy.hub.yaml`, 0o600);
	}
}

/** Refresh only the Buckle ladder and its key environment. The container is
 *  recreated (not merely restarted) because Compose must reread env_file. */
function reloadUpstreams(
	hub: HubProfile,
	name: string,
	version?: string,
): void {
	const dir = requireDir(hub);
	const ref = hubEnvRef(hub, dir);
	if (!ref || !version || ref !== version)
		throw new Error(
			`hubctl reload-upstreams refused: ${name} has stale or unpinned deploy ref; run hubctl push ${name} first`,
		);
	const rendered = renderUpstreams(hub);
	pushGatewayPolicy(hub, dir);
	pushUpstreamEnv(hub, dir);
	const destination = `${dir}/upstreams.hub.yaml`;
	if (hub.deploy?.ssh) {
		execFileSync(
			"ssh",
			[
				...sshOpts(hub),
				hub.deploy.ssh,
				`/bin/sh -c 'umask 077; cat > ${JSON.stringify(destination)}'`,
			],
			{ input: rendered, timeout: 30_000 },
		);
	} else {
		writeFileSync(destination, rendered, { mode: 0o600 });
	}
	const docker = hub.deploy?.docker ?? "docker";
	const command = `${docker} compose -f ${JSON.stringify(`${dir}/hub-compose.yaml`)} --project-directory ${JSON.stringify(dir)} up -d --force-recreate --no-deps buckle-hub`;
	console.log(runOnHub(hub, command, { timeout: 120_000 }).trim());
}

/** Push the compose template + rendered .env to the hub's deploy dir. */
function pushConfig(
	hub: HubProfile,
	name: string,
	auth?: StackConfig["auth"],
	version?: string,
): void {
	if (!existsSync(COMPOSE_TEMPLATE)) {
		throw new Error(`compose template missing: ${COMPOSE_TEMPLATE}`);
	}
	const envText = renderEnv(hub, name, auth, version);
	const dir = requireDir(hub);
	const envPath = `${dir}/.env`;
	// ensure the deploy dir on both paths before any file lands
	if (hub.deploy?.ssh) {
		execFileSync("ssh", [
			...sshOpts(hub),
			hub.deploy.ssh,
			`mkdir -p ${JSON.stringify(dir)}`,
		]);
	} else {
		mkdirSync(dir, { recursive: true });
	}
	copyToHub(hub, COMPOSE_TEMPLATE, `${dir}/hub-compose.yaml`);
	if (hub.deploy?.ssh) {
		execFileSync(
			"ssh",
			[
				...sshOpts(hub),
				hub.deploy.ssh,
				`/bin/sh -c 'cat > ${JSON.stringify(`${dir}/upstreams.hub.yaml`)}'`,
			],
			{ input: renderUpstreams(hub) },
		);
	} else {
		writeFileSync(`${dir}/upstreams.hub.yaml`, renderUpstreams(hub));
	}
	pushGatewayPolicy(hub, dir);
	pushUpstreamEnv(hub, dir);
	// W983: the 0600 owner-prefs file (compose binds it at BUCKLE_PREFS)
	if (hub.deploy?.ssh) {
		execFileSync(
			"ssh",
			[
				...sshOpts(hub),
				hub.deploy.ssh,
				`/bin/sh -c 'umask 077; cat > ${JSON.stringify(`${dir}/buckle-prefs.json`)}; chmod 600 ${JSON.stringify(`${dir}/buckle-prefs.json`)}'`,
			],
			{ input: renderBucklePrefs(hub) },
		);
	} else {
		const prefsPath = `${dir}/buckle-prefs.json`;
		writeFileSync(prefsPath, renderBucklePrefs(hub));
		chmodSync(prefsPath, 0o600);
	}
	if (hub.deploy?.ssh) {
		execFileSync(
			"ssh",
			[
				...sshOpts(hub),
				hub.deploy.ssh,
				`/bin/sh -c 'umask 077; cat > ${JSON.stringify(envPath)}; chmod 600 ${JSON.stringify(envPath)}'`,
			],
			{ input: envText },
		);
		return;
	}
	writeFileSync(envPath, envText, { mode: 0o600 });
	chmodSync(envPath, 0o600);
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

/** docker compose up -d on the hub — the argv lives in hub-remote.ts so
 *  belt's hub heal spawns byte-identical commands. */
function composeUp(hub: HubProfile): void {
	requireDir(hub); // the declared-dir gate + its stack-path error
	const [bin, ...rest] = composeUpArgv(hub);
	// W820: the NAS daemon lags bulk-recreate removals — "removal of
	// container ... is already in progress" clears in seconds; bounded retry.
	for (let attempt = 1; ; attempt++) {
		try {
			console.log(execFileSync(bin, rest, { encoding: "utf8" }).trim());
			return;
		} catch (e) {
			const out = String(
				(e as { output?: unknown[] }).output?.map(String).join("") ?? e,
			);
			if (attempt >= 3 || !out.includes("is already in progress")) throw e;
			console.log(`composeUp: removal race (attempt ${attempt}) — retrying`);
			Bun.sleepSync(5000);
		}
	}
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
	const ps = tryRunOnHub(
		hub,
		`${docker} compose -f ${JSON.stringify(`${dir}/hub-compose.yaml`)} --project-directory ${JSON.stringify(dir)} ps --format json`,
	);
	let failed = 0;
	if (ps === null) {
		// W671: hub exec leg dead — a bounded verdict per leg, never a crash
		failed++;
		console.log(
			`✗ containers: hub unreachable (${hub.deploy?.ssh ?? "local exec"})`,
		);
	} else {
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
	}
	const probes: Array<[string, number, string]> = [
		["buckle-health", hub.buckle_health_port ?? 4112, "/healthz"],
		["buckle-ready", hub.buckle_ready_port ?? 4113, "/healthz"],
		["board-health", hub.board_health_port ?? 7800, "/healthz"],
		["store-health", hub.store_health_port ?? 7794, "/healthz"],
		["belt-health", hub.belt_health_port ?? 7790, "/healthz"],
		...(hub.belt_model
			? [
					["belt-model-health", hub.belt_model.health_port, "/healthz"] as [
						string,
						number,
						string,
					],
				]
			: []),
		["model-store-health", hub.model_store_health_port ?? 7793, "/healthz"],
		// W854: the mdns-health sidecar's verdict port
		["mdns-health", hub.mdns?.sidecar_port ?? 4115, "/healthz"],
	];
	for (const [svc, port, path] of probes) {
		if (!port) continue;
		const out = tryRunOnHub(
			hub,
			`curl --max-time 5 -so /dev/null -w '%{http_code}' http://127.0.0.1:${port}${path} || true`,
		);
		if (out === null) {
			failed++;
			console.log(`✗ ${svc} :${port}${path} → unreachable`);
			continue;
		}
		const code = out.trim();
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
function runtimeReport(
	hub: HubProfile,
	docker: string | undefined,
	dir: string,
): void {
	const dockerBin = docker ?? "docker";
	if (!safeWord(dockerBin)) {
		console.log("· runtime: unknown (invalid configured Docker path)");
		return;
	}
	const compose = `${dockerBin} compose -f ${JSON.stringify(`${dir}/hub-compose.yaml`)} --project-directory ${JSON.stringify(dir)}`;
	try {
		const sourceRoot = hub.repos?.src ?? "/src/fleet/packages";
		if (!safeWord(sourceRoot)) throw new Error("invalid runtime source path");
		const out = runOnHub(
			hub,
			`${compose} exec -T buckle-hub bun ${sourceRoot}/suspenders/deploy/runtime-info.ts --json 2>&1 || true`,
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
	auth?: StackConfig["auth"],
	version?: string,
): void {
	// Validate the immutable source before minting or copying anything.
	renderEnv(hub, name, auth, version);
	mintRootKey(hub);
	pushConfig(hub, name, auth, version);
	composeUp(hub);
	const failed = status(hub);
	if (failed > 0) {
		console.log(
			`deploy: ${name} — ${failed} probe(s) failed after up (services may still be starting; re-check: hubctl status ${name})`,
		);
		process.exit(1);
	}
	// W1124.15: a full install validates the configured cross-hub key
	// lifecycle — a declared key must be VALID on the hub it points at;
	// expired/revoked fails the install with the hub's actual code.
	if (!verifyConfiguredServiceKey(hub, name)) process.exit(1);
	console.log(`deploy: ${name} all healthy`);
}

/** W698: release manifest + SBOM for the checkout, recording the stack
 *  version this hub deploys (--out <dir> writes the three files). */
function emitManifest(pinned: string | undefined, flags: string[]): void {
	const r = buildRelease({
		sha: checkoutSha(),
		pinned,
		schema: schemaVersions(),
	});
	const i = flags.indexOf("--out");
	if (i >= 0 && flags[i + 1]) writeRelease(r, flags[i + 1]);
	else console.log(JSON.stringify(r.manifest, null, 2));
}

// W484.1.1: allowlisted READ-ONLY hub exec — post-flight probes (restart
// counts, package repair state, DSM build) without pulling hub secrets.
// The binary and every argument gate here; arguments also ride a
// metacharacter-free charset so the ssh command string cannot grow a
// second command.
const EXEC_ALLOWLIST: Record<string, { args: RegExp; why: string }> = {
	docker: {
		args: /^(ps(\s+-a\b)?(\s+--format\s+\S+)?|inspect(\s+\S+)+|version|images|stats(\s+--no-stream)?|compose\s+ps(\s+-a\b)?|logs(\s+\S+)?)$/,
		why: "ps|inspect|version|images|stats|compose ps|logs <name>",
	},
	synopkg: {
		args: /^(status(\s+\S+)*|list(\s+\S+)*|checkupdate|version)$/,
		why: "status|list|checkupdate|version (read subcommands only)",
	},
	synoinfo: { args: /^$|^--?[\w-]+$/, why: "info flags only" },
	uname: { args: /^$|^-[ars]$/, why: "flags only" },
	uptime: { args: /^$/, why: "no args" },
	df: { args: /^(-h|-k)?(\s+\/volume\d)?$/, why: "-h|-k [volume]" },
};

/** Every argv element must be a bare safe-shell word — no quotes, no
 *  $/backticks, no separators, no globs. */
function safeWord(a: string): boolean {
	return /^[\w@%+=:,./-]+$/.test(a);
}

/** The denial message's one-line allowlist summary. */
function allowSummary(): string {
	return Object.entries(EXEC_ALLOWLIST)
		.map(([b, e]) => `${b} [${e.why}]`)
		.join(" · ");
}

/** W484.1.1: run an allowlisted read-only command on the hub. The command
 *  rides the existing ssh path (one argv element, BatchMode); output
 *  streams back verbatim for the caller. */
function execHub(hub: HubProfile, name: string, cmd: string[]): void {
	const deny = (why: string): never => {
		console.log(`hubctl exec ${name}: ${why}`);
		process.exit(2);
	};
	if (cmd.length === 0)
		deny(
			`usage: hubctl exec ${name} <cmd...> — allowlisted: ${Object.keys(EXEC_ALLOWLIST).join(", ")}`,
		);
	const [bin, ...args] = cmd;
	const entry = EXEC_ALLOWLIST[bin];
	if (!entry) deny(`"${bin}" not allowlisted (allowed: ${allowSummary()})`);
	if (args.some((a) => !safeWord(a)))
		deny(
			"argument has unsafe characters — bare words only (no quotes/$/;/|/globs)",
		);
	const shape = args.join(" ");
	if (!entry.args.test(shape))
		deny(
			`${bin} ${shape} is not an allowlisted read-only shape (allowed: ${bin} ${entry.why})`,
		);
	// resolve bare allowlist names via the profile's declared path —
	// non-interactive ssh shells don't carry /usr/local/bin (W484.1.1 gap)
	const resolved = bin === "docker" ? (hub.deploy?.docker ?? "docker") : bin;
	try {
		// post-flight probes are quick — bound the exec leg
		process.stdout.write(
			runOnHub(hub, [resolved, ...args].join(" "), { timeout: 60_000 }),
		);
	} catch (e) {
		console.log(
			`hubctl exec: hub unreachable or command failed (${e instanceof Error ? e.message : String(e)})`,
		);
		process.exit(1);
	}
}

// W484.1.1: script run ON the hub — reads the declared root-key file where
// it lives, POSTs the hub's own admin API from inside the device, and
// prints the mint response + http code. The root credential is used in a
// header variable and never printed or transported off the hub.
/** sid charset: sids ride a JSON body key name + the ssh string — bare
 *  word, no separators, ≥3 chars. */
function validSid(s: string | undefined): s is string {
	return s !== undefined && /^[A-Za-z0-9][\w.-]{2,}$/.test(s);
}

/** Probe-key TTL: short-lived by law; 60s..24h, default 3600. */
function validTtl(raw: string): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n >= 60 && n <= 86_400 ? n : null;
}

/** The value after --flag in flags, or undefined when absent/last. */
function flagVal(flags: string[], f: string): string | undefined {
	const i = flags.indexOf(f);
	return i >= 0 ? flags[i + 1] : undefined;
}

/** W1124.15: the deploy-gate face — nothing declared = nothing to check;
 *  declared-and-failed fails the install with the evidence printed above.
 *  (The verification core lives in deploy/service-key.ts; this thin export
 *  binds hubctl's hub-exec runner.) */
export function verifyConfiguredServiceKey(
	hub: HubProfile,
	name: string,
): boolean {
	return serviceKeyVerdict(serviceKeyRunner, hub, name);
}

function mintLaneKey(
	hub: HubProfile,
	name: string,
	sid: string,
	ttl: number,
): void {
	runMintOnHub(
		serviceKeyRunner,
		hub,
		name,
		JSON.stringify({
			name: sid,
			scopes: ["buckle:proxy:WRITE_"],
			expires_in_s: ttl,
		}),
	);
}

function main(): void {
	const [verb, hubName, ...flags] = process.argv.slice(2);
	const force = flags.includes("--force");
	const stack = loadStack();
	const auth = stack.auth;
	if (!hubName || verb === "--help" || verb === "-h") {
		console.log(
			"usage: hubctl <render|mint|push|up|status|deploy|reload-upstreams|manifest|exec|mint-lane-key> <hub> — config: ~/.config/klh/stack.yaml\n" +
				"       up accepts --force: proceed on a stale/unpinned hub .env (refused by default)\n" +
				"       exec runs allowlisted read-only probes; mint-lane-key mints a\n" +
				"       short-lived lane key ON the hub (root credential never leaves it)\n" +
				"       mint-service-key mints a PERSISTENT proxy-only service credential\n" +
				"       (no expiry, --out keyfile at 0600, metadata only on stdout) for\n" +
				"       spoke/persistent links; verify-key checks a\n" +
				"       configured cross-hub key and fails on expired/revoked with the\n" +
				"       hub's actual code; trace-tunnel <hub> up|status|down|peer runs\n" +
				"       the W1097 managed ssh tunnel for the bounded trace connector\n" +
				"       (hubs.<label>.trace_tunnel in stack.yaml)",
		);
		process.exit(hubName ? 0 : 2);
	}
	const hub = requireHub(stack, hubName);
	const hubVersion = hub.version_override ?? stack.version;
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
			console.log(redactedRender(renderEnv(hub, hubName, auth, hubVersion)));
			return;
		case "mint":
			mintRootKey(hub);
			return;
		case "push":
			pushConfig(hub, hubName, auth, hubVersion);
			return;
		case "reload-upstreams":
			reloadUpstreams(hub, hubName, hubVersion);
			return;
		case "up":
			assertHubActivationPreflight(verb);
			upHub(hub, hubName, hubVersion, force);
			return;
		case "deploy":
			assertHubActivationPreflight(verb);
			deployHub(hub, hubName, auth, hubVersion);
			return;
		case "manifest":
			emitManifest(stack.version, flags);
			return;
		case "exec":
			execHub(hub, hubName, flags);
			return;
		case "mint-lane-key": {
			const sid = flagVal(flags, "--sid");
			const ttl = validTtl(flagVal(flags, "--ttl") ?? "3600");
			if (!validSid(sid) || ttl === null) {
				console.log(
					"usage: hubctl mint-lane-key <hub> --sid <sid> [--ttl 60..86400, default 3600]",
				);
				process.exit(2);
			}
			mintLaneKey(hub, hubName, sid, ttl);
			return;
		}
		case "mint-service-key": {
			const name = flagVal(flags, "--name");
			const out = flagVal(flags, "--out");
			if (!validSid(name) || !out) {
				console.log(
					"usage: hubctl mint-service-key <hub> --name <service-name> --out <keyfile> — the raw key lands in --out (0600, never printed)",
				);
				process.exit(2);
			}
			mintServiceKey(serviceKeyRunner, hub, hubName, name, out);
			return;
		}
		case "verify-key": {
			const file = flagVal(flags, "--file");
			const envName = flagVal(flags, "--env");
			if (!file) {
				console.log(
					"usage: hubctl verify-key <hub> --file <key-env-path> [--env NAME] — --env selects inside a multi-variable file",
				);
				process.exit(2);
			}
			process.exit(
				verifyKeyFile(serviceKeyRunner, hub, hubName, file, envName) ? 0 : 1,
			);
			return;
		}
		case "trace-tunnel":
			// the verb owns its exit codes (0 ok · 1 failed · 2 usage) and
			// process.exit()s on every path — never returns here
			void traceTunnelVerb(hub, hubName, flags);
			return;
		default:
			console.log(
				`hubctl: unknown verb "${verb}" — render|mint|push|up|status|deploy|reload-upstreams|manifest|exec|mint-lane-key|mint-service-key|verify-key|trace-tunnel`,
			);
			process.exit(2);
	}
}

if (import.meta.main) main();
