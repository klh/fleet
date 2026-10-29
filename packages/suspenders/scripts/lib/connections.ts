// scripts/lib/connections.ts — W1234: ~/.fleet/config/connections.json —
// which hub desktop GUI apps (claude / chatgpt / vscode) route through, and
// the emission faces that apply that decision. Amendment A law: JSON.parse
// the one parser — no YAML, no secrets (unknown top-level keys are refused:
// an unknown key is the only way to smuggle token material past validation).
// Hub labels resolve through the ONE existing registry chain
// (hooks/lib/hub/hub-locate.ts + stack.yaml) — never a new one.
//
// resolveHubForPath precedence: the repo's .prefer pin (exec-chain `hub=`
// parser — the SOLE pin, W1354.1: a quoted prefer= head token never routes)
// > repos longest-prefix match > default. A repo pinning the ikea copilot sends THAT
// repo through the ikea hub; everything else rides the configured default.
//
// Three emission faces per enabled app:
//   env face        HTTPS_PROXY/HTTP_PROXY/NO_PROXY + ANTHROPIC_BASE_URL to
//                   the hub's buckle gateway face (W1230 pattern) — for
//                   shells/tools that honor proxy env. OPT-IN: rendered for
//                   eval in a specific shell, never applied machine-wide.
//   launchctl face  RETIRED (W2284, owner ruling 2026-10-29: the buckle
//                   proxy is NOT a system proxy) — `launchctl setenv`
//                   pollutes the whole launchd user domain (every terminal,
//                   npm, git and test run). The install step now only
//                   unsets; GUIs ride the singbox face instead.
//   enforcement     OPTIONAL sing-box config (JSON, authenticated CONNECT
//   face            relay ONLY — TLS opaque end-to-end, never MITM;
//                   W1231/W1233/W1260.2): TUN + AI-qualified process rules
//                   per enabled GUI app → per-app buckle-connect outbound.
//
// Config-over-code: real hosts live in the machine config + registry only;
// this file carries none.
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
	AI_DESTINATION_SUFFIXES,
	CONNECT_PORT_DEFAULT,
	CONNECT_UNKNOWN_USER,
	connectTagOf,
	guiTransports,
} from "../../deploy/singbox/watched.ts";
import { readRegistry, resolveHub } from "../../hooks/lib/hub/hub-locate.ts";
import { tryLoadStack } from "../../hooks/lib/stack-config.ts";
import {
	defineVerb,
	type Parsed,
	runCli,
	type VerbSpec,
} from "../../hooks/lib/verb-kit.ts";
import { preferOf } from "./exec-chain.ts";

// ─── schema ──────────────────────────────────────────────────────────────────

/** The supported apps — the one set; unknown app keys are refused. */
export type AppName = "claude" | "chatgpt" | "vscode" | "codex";

export const KNOWN_APPS: readonly AppName[] = [
	"claude",
	"chatgpt",
	"vscode",
	"codex",
];

export const CONNECTIONS_PATH = (): string =>
	process.env.SUSPENDERS_CONNECTIONS_FILE ??
	join(process.env.HOME ?? "", ".fleet", "config", "connections.json");

/** The one schema: no other top-level key is accepted (no-secrets law). */
export interface ConnectionsConfig {
	version: 1;
	default: string;
	apps?: Partial<Record<AppName, { enabled: boolean }>>;
	repos?: Record<string, string>;
}

export type ConnectionsLoad =
	| { ok: true; config: ConnectionsConfig; path: string; mode?: number }
	| { ok: false; why: string; path: string };

const isAppName = (v: string): v is AppName =>
	KNOWN_APPS.includes(v as AppName);

/** Strict load + validate. Missing file = ok:false "absent" (the caller —
 *  the install step — decides whether to write the template). */
export function loadConnections(
	path: string = CONNECTIONS_PATH(),
): ConnectionsLoad {
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { ok: false, why: "absent", path };
	}
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch (e) {
		return { ok: false, why: `unparseable JSON: ${String(e)}`, path };
	}
	const cfg = doc as Partial<ConnectionsConfig> | null;
	if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg))
		return { ok: false, why: "root must be a JSON object", path };
	for (const k of Object.keys(cfg))
		if (!["version", "default", "apps", "repos"].includes(k))
			return {
				ok: false,
				why: `unknown top-level key '${k}' — schema is version|default|apps|repos`,
				path,
			};
	if (cfg.version !== 1)
		return { ok: false, why: "version must be exactly 1", path };
	if (typeof cfg.default !== "string" || cfg.default.trim() === "")
		return { ok: false, why: "default must be a non-empty hub label", path };
	if (cfg.apps !== undefined) {
		if (typeof cfg.apps !== "object" || cfg.apps === null)
			return { ok: false, why: "apps must be an object", path };
		for (const [app, row] of Object.entries(cfg.apps)) {
			if (!isAppName(app))
				return {
					ok: false,
					why: `unknown app '${app}' — known: ${KNOWN_APPS.join(", ")}`,
					path,
				};
			const enabled = (row as { enabled?: unknown } | null)?.enabled;
			if (typeof enabled !== "boolean")
				return {
					ok: false,
					why: `apps.${app} must be {enabled: boolean}`,
					path,
				};
		}
	}
	if (cfg.repos !== undefined) {
		if (typeof cfg.repos !== "object" || cfg.repos === null)
			return { ok: false, why: "repos must be an object", path };
		for (const [prefix, label] of Object.entries(cfg.repos))
			if (typeof label !== "string" || label.trim() === "")
				return {
					ok: false,
					why: `repos['${prefix}'] must be a non-empty hub label`,
					path,
				};
	}
	let mode: number | undefined;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		// stat after a successful read is non-fatal
	}
	return { ok: true, config: cfg as ConnectionsConfig, path, mode };
}

// ─── resolution ──────────────────────────────────────────────────────────────

export interface HubResolution {
	hub: string | null;
	via: "prefer-pin" | "repos" | "default" | "none";
	/** where the decision came from — the .prefer file or the matched prefix */
	source?: string;
}

/** Longest-prefix repo match: a prefix matches when the path IS the prefix or
 *  lives under it (separator boundary — /tmp/a must not match /tmp/ab). */
export function longestPrefixHub(
	repos: Record<string, string>,
	path: string,
): { hub: string; source: string } | null {
	const norm = resolvePath(path);
	const keys = Object.keys(repos).sort((a, b) => b.length - a.length);
	for (const k of keys) {
		const prefix = k.endsWith("/") ? k : `${k}/`;
		if (norm === k || norm.startsWith(prefix))
			return { hub: repos[k] ?? "", source: k };
	}
	return null;
}

/** Hub labels known to the ONE registry chain: stack.yaml profiles + the
 *  hubs.json registry keys (exec-chain hubLabelOf precedent — never a second
 *  registry). */
export function knownHubs(): string[] {
	const out = new Set<string>();
	try {
		for (const l of Object.keys(tryLoadStack()?.hubs ?? {})) out.add(l);
	} catch {
		// no/bad stack.yaml — the registry still counts
	}
	for (const l of Object.keys(readRegistry())) out.add(l);
	return [...out];
}

/** Case-insensitive membership; returns the registry's own key form. */
export const knownHubLabel = (
	label: string,
	known: string[] = knownHubs(),
): string | null =>
	known.find((l) => l.toLowerCase() === label.trim().toLowerCase()) ?? null;

/** The .prefer pin: walk up from the path, nearest .prefer wins. The ONLY
 *  pin is the executor chain's unquoted `hub=Label` (exec-chain.ts preferOf
 *  — explicit, wins). W1354.1: the routing plane's quoted prefer= expression
 *  never pins — a quoted must=/prefer= line is a SOFT hint (W1353), so its
 *  head token naming a hub label no longer routes the repo (was: first token
 *  vs known hubs). parseRoutingPrefer flags the cross-plane `hub=` as
 *  unknown-key errors — expected noise, never fatal. */
export function preferPin(startPath: string): {
	hub: string;
	hubUrls: string[];
	source: string;
} | null {
	// a nonexistent path is fine — walk from its nearest existing ancestor
	const st = existsSync(startPath) ? statSync(startPath) : null;
	let dir = st?.isDirectory() ? startPath : dirname(resolvePath(startPath));
	for (let i = 0; i < 64; i++) {
		const f = join(dir, ".prefer");
		if (existsSync(f)) {
			const p = preferOf(dir);
			if (p.hub) return { hub: p.hub, hubUrls: p.hubUrls, source: f };
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** resolveHubForPath — the ONE decision: prefer-pin > repos longest-prefix >
 *  default. Pure over cfg (no network). W1354.1: the injected known-hub set
 *  is gone with the head-token pin — only unquoted hub= pins. */
export function resolveHubForPath(
	path: string,
	cfg: ConnectionsConfig,
): HubResolution {
	const pin = preferPin(path);
	if (pin) return { hub: pin.hub, via: "prefer-pin", source: pin.source };
	const repo = longestPrefixHub(cfg.repos ?? {}, path);
	if (repo) return { hub: repo.hub, via: "repos", source: repo.source };
	return { hub: cfg.default, via: "default" };
}

// ─── faces ───────────────────────────────────────────────────────────────────

/** A proxy URL never carries credentials or a path — scheme http + host:port
 *  only. */
export const proxyBaseOf = (url: string): string => {
	const u = new URL(url);
	const port = u.port || (u.protocol === "https:" ? "443" : "80");
	return `http://${u.hostname}:${port}`;
};

export const NO_PROXY_DEFAULT = "127.0.0.1,::1,localhost,*.local,.local,*.lan";

// ─── the authenticated CONNECT face (W2198) ──────────────────────────────────

/** The live authenticated CONNECT egress (connect-egress.ts) the proxy env
 *  pairs MUST point at — never a buckle serve port (4101/4111 serve the API
 *  gate, not CONNECT; pointing proxy env there poisons every inheriting GUI
 *  app — the 2026-10-28 outage this fix closes). */
export interface ConnectFace {
	host: string;
	port: number;
	token: string;
}

/** Resolve the CONNECT face for a hub URL: host from the hub, port/token
 *  from machine config (BUCKLE_CONNECT_PORT default 4103; the token rides
 *  env BUCKLE_CONNECT_TOKEN, or BUCKLE_CONNECT_TOKEN_FILE, or the default
 *  0600 mint file — machine-minted on the gateway host, never committed).
 *  null = not configured — every proxy-env emission MUST skip loudly, never
 *  fall back to a serve port. */
export const CONNECT_TOKEN_FILE_DEFAULT = (): string =>
	join(process.env.HOME ?? "", ".claude", "local-llm", "buckle-connect.key");

export function connectFaceOf(
	hubUrl: string,
	env: Record<string, string | undefined> = process.env,
): ConnectFace | null {
	let token = (env.BUCKLE_CONNECT_TOKEN ?? "").trim();
	if (token === "" && env.BUCKLE_CONNECT_TOKEN_FILE) {
		try {
			token = readFileSync(env.BUCKLE_CONNECT_TOKEN_FILE, "utf8").trim();
		} catch {
			token = "";
		}
	}
	if (token === "") {
		try {
			token = readFileSync(CONNECT_TOKEN_FILE_DEFAULT(), "utf8").trim();
		} catch {
			token = "";
		}
	}
	if (token === "") return null;
	const port = Number(env.BUCKLE_CONNECT_PORT ?? "") || CONNECT_PORT_DEFAULT;
	return { host: new URL(hubUrl).hostname, port, token };
}

/** The CONNECT identity env-honoring clients ride. The shared env face is
 *  process-anonymous by construction — `buckle` is the generic bucket
 *  (connect-egress.ts maps it to app "unknown"); per-app identities exist
 *  only in the singbox face's per-process rules. */
export const CONNECT_ENV_USER = "buckle";

/** Probe the CONNECT face over the real wire before any proxy env is set:
 *  ride Bun fetch's proxy support through the face to an allowed AI
 *  destination. A completed exchange proves the face relayed the CONNECT
 *  (the destination's HTTP status is the DESTINATION's answer, not the
 *  face's — the face's own verdict is implicit in the exchange completing);
 *  connection failure = no face. Callers never emit proxy env from a dead
 *  probe. */
export async function probeConnectFace(
	face: ConnectFace,
	destination = "https://api.anthropic.com/",
	timeoutMs = 2500,
): Promise<{ ok: boolean; why: string }> {
	const proxy = `http://${CONNECT_ENV_USER}:${face.token}@${face.host}:${face.port}`;
	try {
		const r = await fetch(destination, {
			proxy,
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "manual",
		});
		return {
			ok: true,
			why: `CONNECT relayed (destination answered ${r.status})`,
		};
	} catch (e) {
		return { ok: false, why: `no CONNECT face: ${String(e).slice(0, 120)}` };
	}
}

export interface EnvPair {
	key: string;
	value: string;
	/** when a pair applies to one app only (ANTHROPIC_BASE_URL → claude) */
	app?: AppName;
}

/** The env face's pair vocabulary: the authenticated CONNECT relay (creds
 *  embedded — the ONLY channel an env-honoring client can authenticate
 *  through; Proxy-Authorization cannot be pre-set via env) for proxied
 *  traffic, the hub's buckle gateway face for Anthropic-wire clients
 *  (claude only — W1230 pattern). W2198: the proxy pairs REQUIRE a
 *  probed-live ConnectFace — a serve port never rides proxy env. W2284:
 *  these pairs are rendered ONLY by the opt-in `connections emit env`
 *  face (an explicit eval in a specific shell) — nothing applies them
 *  machine-wide any more. The relay token is machine-minted,
 *  CONNECT-scoped and loopback-bound — provider keys still never ride
 *  these pairs (assertNoSecrets law unchanged). */
export function facePairs(
	enabled: AppName[],
	url: string,
	connect?: ConnectFace | null,
): EnvPair[] {
	const pairs: EnvPair[] = [];
	if (connect) {
		const proxy = `http://${CONNECT_ENV_USER}:${connect.token}@${connect.host}:${connect.port}`;
		pairs.push(
			{ key: "HTTPS_PROXY", value: proxy },
			{ key: "HTTP_PROXY", value: proxy },
		);
	} else {
		// W2198: an absent face emits ACTIVE UNSET rows (empty value) so a
		// shell that evals this face clears any stale proxy instead of
		// leaving a dead serve-port proxy behind.
		pairs.push(
			{ key: "HTTPS_PROXY", value: "" },
			{ key: "HTTP_PROXY", value: "" },
		);
	}
	pairs.push({ key: "NO_PROXY", value: NO_PROXY_DEFAULT });
	if (enabled.includes("claude"))
		pairs.push({ key: "ANTHROPIC_BASE_URL", value: url, app: "claude" });
	return pairs;
}

export const enabledAppsOf = (
	cfg: ConnectionsConfig,
	only?: string,
): AppName[] => {
	const apps = KNOWN_APPS.filter((a) => cfg.apps?.[a]?.enabled === true);
	return only ? apps.filter((a) => a === only) : apps;
};

// Watch signatures — the ONE source is the TUN kit's GUI transport table
// (deploy/singbox/watched.ts guiTransports()): GUI TRANSPORTS ONLY, the
// install-detection boundary stays in the fleet-install catalog (owner
// boundary: watched.ts never detects, never lists CLI paths). CLIs (claude/
// codex) steer via user-level tool config (owner #67959 — never per-repo
// .codex/config.toml); unknown processes' AI destinations ride the `buckle`
// fallback rule (fail-closed CONNECT gate).

/** OPTIONAL enforcement face: sing-box config, authenticated CONNECT relay
 *  ONLY (TLS opaque end-to-end — never MITM; W1231/W1233/W1260.2). Per-app
 *  CONNECT outbounds (username = app identity, one shared BUCKLE_CONNECT_
 *  TOKEN from env; conf written 0600). Ordering law: sniff → dns hijack →
 *  private/LAN bypass FIRST, GUI app rules AI-destination-qualified, then
 *  the unknown-process AI fallback as `buckle`, final direct. GUI transports
 *  only — CLIs steer via user-level tool config (owner #67959). The server
 *  is the resolved hub gateway host (machine TUN kit rides loopback instead). */
export function singboxConfig(
	enabled: AppName[],
	url: string,
): Record<string, unknown> {
	const u = new URL(url);
	const port =
		Number(process.env.BUCKLE_CONNECT_PORT ?? "") || CONNECT_PORT_DEFAULT;
	const token = process.env.BUCKLE_CONNECT_TOKEN ?? "";
	// sing-box direct ranges — the loopback/RFC1918/link-local space the TUN
	// must never capture (routing table data, not host secrets — scrub:allow)
	const direct = [
		"127.0.0.0/8", // scrub:allow
		"10.0.0.0/8", // scrub:allow
		"172.16.0.0/12", // scrub:allow
		"192.168.0.0/16", // scrub:allow
		"169.254.0.0/16", // scrub:allow
		"::1/128",
		"fc00::/7",
		"fe80::/10",
	];
	const rules: Record<string, unknown>[] = [
		{ action: "sniff" },
		{ protocol: "dns", action: "hijack-dns" },
		{ ip_cidr: direct, outbound: "direct" },
		{ domain_suffix: [".local", ".lan"], outbound: "direct" },
	];
	// GUI-transport rules for the enabled apps — AI-destination-qualified,
	// per-app CONNECT tags. Watched-app NON-AI traffic stays direct by law
	// (final: direct); CONNECT is the fail-closed AI gate only.
	const transports = guiTransports().filter((t) => enabled.includes(t.user));
	const outbounds: Record<string, unknown>[] = transports.map((t) => ({
		type: "http",
		tag: connectTagOf(t.user),
		server: u.hostname,
		server_port: port,
		username: t.user,
		password: token,
	}));
	for (const t of transports)
		rules.push({
			process_path_regex: [t.regex],
			domain_suffix: [...AI_DESTINATION_SUFFIXES],
			outbound: connectTagOf(t.user),
		});
	// unknown-process AI fallback — still authenticated CONNECT, still the
	// shared token, bucket `buckle` (never a catch-all relay)
	rules.push({
		domain_suffix: [...AI_DESTINATION_SUFFIXES],
		outbound: connectTagOf(CONNECT_UNKNOWN_USER),
	});
	outbounds.push({
		type: "http",
		tag: connectTagOf(CONNECT_UNKNOWN_USER),
		server: u.hostname,
		server_port: port,
		username: CONNECT_UNKNOWN_USER,
		password: token,
	});
	outbounds.push({ type: "direct", tag: "direct" });
	return {
		log: { level: "warn" },
		inbounds: [
			{
				type: "tun",
				tag: "tun-in",
				address: ["172.19.0.1/30"], // scrub:allow — TUN interface range
				auto_route: true,
				strict_route: true,
			},
		],
		outbounds,
		route: { rules, final: "direct", auto_detect_interface: true },
	};
}

// ─── writes ──────────────────────────────────────────────────────────────────

/** Write the connections file at mode 600 (dir 700). Never called when the
 *  file already exists — the caller (install step) owns that law. */
export function writeDefaultConfig(
	path: string,
	config: ConnectionsConfig,
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, {
		mode: 0o600,
	});
	chmodSync(path, 0o600); // umask can mask the mode bit — force it
}

// ─── no-secrets assertion ────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
	/sk-[A-Za-z0-9]{16,}/,
	/bksk_[A-Za-z0-9]{16,}/,
	/AKIA[0-9A-Z]{16}/,
	/ghp_[A-Za-z0-9]{30,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** The faces and the written config NEVER carry key material — every emit
 *  path asserts it before printing/writing (Amendment A: secrets stay in
 *  hub env / bksk_ mints, never here). */
export function assertNoSecrets(text: string): void {
	for (const re of SECRET_PATTERNS)
		if (re.test(text))
			throw new Error(
				`no-secrets assertion tripped (${re.source.slice(0, 24)}) — key material never rides connections faces`,
			);
}

// ─── CLI verb face (verb-kit, W651) ─────────────────────────────────────────

const VERBS: VerbSpec[] = [
	defineVerb({
		name: "show",
		usage:
			"usage: show [--json] — the loaded connections.json + per-hub registry status",
		switches: ["--json"],
		lax: true,
	}),
	defineVerb({
		name: "resolve",
		usage:
			"usage: resolve <abs-path> [--json] — hub for a repo path (prefer-pin > repos > default)",
		minPos: 1,
		switches: ["--json"],
	}),
	defineVerb({
		name: "emit",
		usage:
			"usage: emit <env|singbox> [--app <name>] [--out <file>] — the routing faces (the universal launchctl face is retired — W2284)",
		minPos: 1,
		flags: ["--app", "--out"],
	}),
];

/** Hub label → real endpoint through the ONE registry chain (hub-locate
 *  resolveHub: env override > .prefer hub-url > stack.yaml > hubs.json >
 *  dns-sd > mdns guess). url only — the token never leaves the hub layer. */
export const resolveEndpoint = (
	label: string,
	hubUrls: string[] = [],
): Promise<{ url: string; via: string } | null> =>
	resolveHub(label, hubUrls).then((h) =>
		h ? { url: h.url, via: h.via } : null,
	);

const emitUndo = (pairs: EnvPair[]): string[] =>
	pairs.map((p) => `# undo: unset ${p.key}`);

const renderFace = (
	face: string,
	apps: AppName[],
	url: string,
	connect?: ConnectFace | null,
): string => {
	if (face === "singbox")
		return `${JSON.stringify(singboxConfig(apps, url), null, "\t")}\n`;
	const pairs = facePairs(apps, url, connect);
	const lines = pairs.map((p) => `export ${p.key}=${p.value}`);
	return `${[...lines, ...emitUndo(pairs)].join("\n")}\n`;
};

// dispatch — show | resolve | emit
async function dispatch(name: string, parsed: Parsed): Promise<number> {
	const load = loadConnections();
	if (name === "show") {
		if (!load.ok) {
			console.error(`connections: ${load.why} at ${load.path}`);
			return 1;
		}
		if (parsed.flag("--json")) {
			console.log(JSON.stringify(load, null, "\t"));
			return 0;
		}
		const c = load.config;
		console.log(`path:   ${load.path} (mode ${load.mode?.toString(8) ?? "?"})`);
		console.log(`default hub: ${c.default}`);
		for (const a of KNOWN_APPS)
			console.log(
				`app ${a}: ${c.apps?.[a]?.enabled === true ? "enabled" : "disabled"}`,
			);
		console.log(`repo overrides: ${Object.keys(c.repos ?? {}).length}`);
		return 0;
	}
	// resolve + emit need a resolvable config
	if (!load.ok) {
		console.error(`connections: ${load.why} at ${load.path}`);
		return 1;
	}
	const cfg = load.config;
	if (name === "resolve") {
		const path = parsed.pos[0] ?? ".";
		const r = resolveHubForPath(path, cfg);
		const ep = r.hub ? await resolveEndpoint(r.hub) : null;
		if (parsed.flag("--json")) {
			console.log(JSON.stringify({ path, ...r, endpoint: ep }, null, "\t"));
			return r.hub && ep ? 0 : 1;
		}
		console.log(`path: ${path}`);
		console.log(
			`hub:  ${r.hub ?? "(none)"} (via ${r.via})${r.source ? ` — ${r.source}` : ""}`,
		);
		console.log(
			`url:  ${ep ? `${ep.url} (via ${ep.via})` : "UNRESOLVED — check hubs registry/stack.yaml"}`,
		);
		return r.hub && ep ? 0 : 1;
	}
	// emit <face> — the launchctl face is retired (W2284: a universal
	// launchd-domain proxy is NOT the intent; the install step unsets, the
	// scoped env/singbox faces route)
	const face = parsed.pos[0] ?? "";
	if (!["env", "singbox"].includes(face)) {
		console.error(
			`connections: unknown face '${face}' — env|singbox (launchctl retired, W2284)`,
		);
		return 2;
	}
	const apps = enabledAppsOf(cfg, parsed.flag("--app") ?? undefined);
	if (apps.length === 0) {
		console.error(
			"connections: no enabled apps — flip apps.<name>.enabled in connections.json",
		);
		return 1;
	}
	const ep = await resolveEndpoint(cfg.default);
	if (!ep) {
		console.error(
			`connections: default hub '${cfg.default}' unresolved — fix the hubs registry or stack.yaml`,
		);
		return 1;
	}
	if (face === "singbox" && !process.env.BUCKLE_CONNECT_TOKEN) {
		console.error(
			"connections: BUCKLE_CONNECT_TOKEN missing — never a placeholdered CONNECT conf (W1233 lesson)",
		);
		return 1;
	}
	// W2198: the env face rides the authenticated CONNECT face —
	// resolved from machine env, probed live BEFORE any emission. Not
	// configured or not answering = the face renders proxy-free (NO_PROXY +
	// the claude serve base URL only) with the reason on stderr — never a
	// serve port in proxy env.
	const connect = connectFaceOf(ep.url);
	let connectLive: ConnectFace | null = null;
	if (face === "env" && connect) {
		const probe = await probeConnectFace(connect);
		if (!probe.ok) {
			console.error(
				`connections: ${probe.why} — proxy pairs render as UNSET rows`,
			);
		} else {
			connectLive = connect;
			console.error(`connections: ${probe.why}`);
		}
	} else if (face === "env") {
		// W2198 review N2: unconfigured must be LOUD too — the install path
		// says why; the verb path owed the same reason on stderr.
		console.error(
			"connections: BUCKLE_CONNECT_TOKEN unset — proxy pairs render as UNSET rows (enable gateway.connect on the spoke)",
		);
	}
	const text = renderFace(face, apps, ep.url, connectLive);
	assertNoSecrets(text);
	const out = parsed.flag("--out");
	if (out && face === "singbox") {
		writeFileSync(out, text, { mode: 0o600 });
		chmodSync(out, 0o600);
		console.error(`wrote ${out} (mode 600)`);
		return 0;
	}
	if (out) {
		console.error("connections: --out applies to the singbox face only");
		return 2;
	}
	process.stdout.write(text);
	return 0;
}

if (import.meta.main)
	await runCli({
		prog: "connections",
		about: "W1234 — connections.json resolver + GUI routing faces",
		verbs: VERBS,
		dispatch,
	});
