#!/usr/bin/env bun
// klh-local.ts — one command per local service: Caddy site + dns-sd claim + registry.
//   bun klh-local.ts install
//   bun klh-local.ts register <name> --port N [--health /p] [--no-dns] [--lan --forward-auth URL]
//   bun klh-local.ts list | status | deregister <name> | reload
//   sudo bun klh-local.ts hosts-apply [--registry PATH]

import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { probeService, serviceTarget } from "./dashboard-health.ts";
import {
	activeRouteMatches,
	fetchActiveConfig,
	reconcileDnsClaim,
} from "./dns-reconcile.ts";
import { maintainDnsClaims, releaseOwnedClaims } from "./dns-maintenance.ts";

const die = (msg: string): never => {
	console.error(`✗ ${msg}`);
	return process.exit(1) as never;
};

// PATH lookup first (command -v semantics), then the Apple-Silicon and Intel
// Homebrew prefixes — launchd and sudo run with a minimal PATH.
export const resolveBin = (name: string, fallbacks: string[]): string =>
	Bun.which(name) ?? fallbacks.find((p) => existsSync(p)) ?? fallbacks[0];
const caddyBin = (): string =>
	resolveBin("caddy", ["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy"]);

const HOME = process.env.HOME ?? die("HOME unset");
let CADDY = caddyBin();
const BREW = resolveBin("brew", [
	"/opt/homebrew/bin/brew",
	"/usr/local/bin/brew",
]);
const DNS_SD = "/usr/bin/dns-sd";
const IPCONFIG = "/usr/sbin/ipconfig";
const STATE = `${HOME}/.local/state/klh-local`;
const SITES = `${STATE}/sites`;
const CADDYFILE = `${STATE}/Caddyfile`;
const fragmentPath = (name: string): string => `${SITES}/${name}.caddy`;
const PLIST = `${HOME}/Library/LaunchAgents/com.klh-local.caddy.plist`;
const LABEL = "com.klh-local.caddy";
const REGISTRY = `${STATE}/registry.json`;
const REGISTRY_LOCK = `${REGISTRY}.lock`;
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const HOSTS = "/etc/hosts";
const HOSTS_START = "# --- klh-local managed: start ---";
const HOSTS_END = "# --- klh-local managed: end ---";

type Dns = { claimed: boolean; pid?: number };
type Route = { path: string; port: number };
// Loopback by default; LAN exposure is opt-in and always authenticated.
export type Exposure = {
	lan: boolean;
	forwardAuth?: string;
	upstream?: string;
};
type Service = {
	name: string;
	port: number;
	health_path: string;
	routes?: Route[];
	lan?: boolean;
	forward_auth?: string;
	upstream?: string;
	dns: Dns;
	caddy: { conf_path: string };
	created_at: string;
};
type Registry = Service[];

// Unique tmp name in the target's directory, then rename: readers never see a
// partial file and concurrent writers never share (and clobber) one tmp.
export const writeAtomic = (
	path: string,
	content: string,
	mode?: number,
): void => {
	const tmp = `${dirname(path)}/.${basename(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
};

const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
};

const LOCK_STALE_MS = 60_000;
const heldLocks = new Set<string>();
process.on("exit", () => {
	for (const l of heldLocks) rmSync(l, { recursive: true, force: true });
});

const lockStale = (lockDir: string): boolean => {
	try {
		const age = Date.now() - statSync(lockDir).mtimeMs;
		if (age > LOCK_STALE_MS) return true;
		const pid = Number(readFileSync(`${lockDir}/pid`, "utf8"));
		return Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
	} catch {
		return false; // owner is between mkdir and writing its pid, or just released
	}
};

// mkdir is atomic: exactly one process creates the lock dir. A lock whose owner
// died (or that outlived LOCK_STALE_MS) is renamed aside, then retried.
export const withLock = <T>(
	lockDir: string,
	fn: () => T,
	timeoutMs = 15_000,
): T => {
	const t0 = Date.now();
	for (;;) {
		try {
			mkdirSync(lockDir);
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		if (lockStale(lockDir)) {
			const aside = `${lockDir}.stale-${process.pid}-${randomUUID().slice(0, 8)}`;
			try {
				renameSync(lockDir, aside);
				rmSync(aside, { recursive: true, force: true });
			} catch {}
			continue;
		}
		if (Date.now() - t0 > timeoutMs)
			throw new Error(`lock busy for ${timeoutMs}ms: ${lockDir}`);
		Bun.sleepSync(20);
	}
	heldLocks.add(lockDir);
	try {
		writeFileSync(`${lockDir}/pid`, String(process.pid));
		return fn();
	} finally {
		heldLocks.delete(lockDir);
		rmSync(lockDir, { recursive: true, force: true });
	}
};

export const readRegistryAt = (path: string): Registry => {
	if (!existsSync(path)) return [];
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Registry;
	} catch {
		return die(`registry unreadable: ${path} (fix or remove it)`);
	}
};

export const saveRegistryAt = (path: string, reg: Registry): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeAtomic(path, `${JSON.stringify(reg, null, 2)}\n`);
};

// Read-modify-write under the registry lock — concurrent installers serialize.
export const updateRegistryAt = <T>(
	path: string,
	fn: (reg: Registry) => { next?: Registry; result: T },
): T => {
	mkdirSync(dirname(path), { recursive: true });
	return withLock(`${path}.lock`, () => {
		const { next, result } = fn(readRegistryAt(path));
		if (next) saveRegistryAt(path, next);
		return result;
	});
};

const readRegistry = (): Registry => readRegistryAt(REGISTRY);
const saveRegistry = (reg: Registry): void => saveRegistryAt(REGISTRY, reg);
const withRegistryLock = <T>(fn: () => T): T => {
	mkdirSync(STATE, { recursive: true });
	try {
		return withLock(REGISTRY_LOCK, fn);
	} catch (e) {
		return die(String((e as Error).message));
	}
};

const run = (argv: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	const out =
		`${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`.trim();
	return { code: p.exitCode ?? 1, out };
};

const psComm = (pid: number): string => {
	const p = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "comm="], {
		stdout: "pipe",
		stderr: "ignore",
	});
	return p.exitCode === 0 ? (p.stdout?.toString() ?? "") : "";
};

// A stored pid is only ours while it is still dns-sd — after a reboot the
// number can belong to anything, and we must neither trust nor kill it.
export const dnsAlive = (
	pid?: number,
	comm: (pid: number) => string = psComm,
): boolean =>
	Number.isInteger(pid) &&
	(pid ?? 0) > 0 &&
	basename(comm(pid ?? 0).trim()) === "dns-sd";

// The enterprise SSO seam: a --lan site must sit behind forward_auth. Only
// plain http(s) URLs with conservative characters reach the config file.
export const parseForwardAuth = (
	raw: string,
): { upstream: string; uri: string } | null => {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return null;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return null;
	if (u.username || u.password || u.hash) return null;
	if (!/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/.test(u.hostname)) return null;
	const uri = `${u.pathname}${u.search}`;
	if (!/^\/[A-Za-z0-9/_.~%?=&-]*$/.test(uri)) return null;
	return { upstream: `${u.protocol}//${u.host}`, uri };
};

const exposureLines = (exposure: Exposure): string => {
	// Listener-level `bind 127.0.0.1 ::1` is unloadable on macOS: unprivileged
	// processes cannot bind a specific address on ports <1024 (EACCES — kernel
	// verified; wildcard binds are allowed), so a loopback-bound :443 site can
	// neither reload under the wildcard catch-all nor boot. The deny therefore
	// lives at the request level: listeners stay wildcard, external remotes are
	// aborted before any handler runs.
	if (!exposure.lan)
		return "\t@external not remote_ip 127.0.0.1 ::1\n\tabort @external\n";
	const fa = parseForwardAuth(exposure.forwardAuth ?? "");
	if (!fa) throw new Error("--lan requires a valid --forward-auth URL");
	return `\tforward_auth ${fa.upstream} {
		uri ${fa.uri}
		copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
	}
`;
};

export const fragmentConf = (
	name: string,
	port: number,
	routes: Route[] = [],
	exposure: Exposure = { lan: false },
): string => {
	const scope = exposure.lan
		? `LAN, forward_auth ${exposure.forwardAuth}`
		: "loopback only";
	const target = exposure.upstream ?? `127.0.0.1:${port}`;
	const header = `# klh-local fragment — https://${name}.local/ → ${target} (${scope}; auto-HTTPS via Caddy internal CA)`;
	const bindOrAuth = exposureLines(exposure);
	if (routes.length === 0)
		return `${header}
${name}.local {
${bindOrAuth}	reverse_proxy ${target}
}
`;
	// handle blocks are mutually exclusive and matcher-ordered: path routes
	// win over the default handle, and every route preserves the request path.
	const handles = routes
		.map(
			(r) =>
				`\thandle ${r.path} {
		reverse_proxy 127.0.0.1:${r.port}
	}
`,
		)
		.join("");
	return `${header}
${name}.local {
${bindOrAuth}${handles}	handle {
		reverse_proxy ${target}
	}
}
`;
};

const caddyfileSkeleton =
	(): string => `# klh-local managed Caddyfile — per-service fragments are imported from sites/ below.
# The catch-all block is the security posture: any Host with no registered site dies here.
# Caddy sorts site blocks by specificity — named hosts always win over this catch-all.
import ${SITES}/*.caddy

http://:80, https://:443 {
	abort
}
`;

const plistConf = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${CADDY}</string>
		<string>run</string>
		<string>--config</string>
		<string>${CADDYFILE}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${STATE}/caddy.log</string>
	<key>StandardErrorPath</key>
	<string>${STATE}/caddy.log</string>
</dict>
</plist>
`;

// Stage the candidate fragment next to copies of every other live fragment,
// validate that staged config, and only then move it into sites/ — a fragment
// Caddy cannot load never lands where it would poison every later reload. A
// failed reload restores the prior fragment content (or removes a new one).
// `served` (ccc951b pattern): when the running instance already serves the
// claim, converge the fragment WITHOUT reloading — the instance is
// authoritative and a reload would only re-bind its listeners.
export type FragmentResult =
	| { ok: true }
	| { ok: false; stage: "reload" | "validate"; out: string };
// macOS maps cross-process port conflicts to EACCES (specific-vs-wildcard) or
// EADDRINUSE (wildcard-vs-wildcard) — both transient: the conflicting holder
// (a draining KeepAlive restart, a lane's scratch caddy) exits within seconds.
// Backoff then --force: force re-provisions identical bytes, re-attempting the
// binds the first reload lost.
const RELOAD_BACKOFF_MS = [250, 750];
const reloadWithRetry = (
	caddyfile: string,
	reload: (caddyfile: string, force: boolean) => { code: number; out: string },
): { code: number; out: string } => {
	let r = reload(caddyfile, false);
	for (const ms of RELOAD_BACKOFF_MS) {
		if (r.code === 0) return r;
		Bun.sleepSync(ms);
		r = reload(caddyfile, true);
	}
	return r;
};
export const applyFragment = (opts: {
	sites: string;
	caddyfile: string;
	name: string;
	content: string;
	validate: (caddyfile: string) => { code: number; out: string };
	reload: (caddyfile: string, force: boolean) => { code: number; out: string };
	served?: () => boolean;
}): FragmentResult => {
	const { sites, caddyfile, name, content } = opts;
	const frag = `${sites}/${name}.caddy`;
	const live = readFileSync(caddyfile, "utf8");
	if (!live.includes(`${sites}/`))
		return {
			ok: false,
			stage: "validate",
			out: `${caddyfile} does not import ${sites}/ — re-run: klh-local install`,
		};
	const stage = `${dirname(caddyfile)}/.stage-${process.pid}-${randomUUID().slice(0, 8)}`;
	try {
		mkdirSync(`${stage}/sites`, { recursive: true });
		for (const f of readdirSync(sites))
			if (f.endsWith(".caddy") && f !== `${name}.caddy`)
				copyFileSync(`${sites}/${f}`, `${stage}/sites/${f}`);
		writeFileSync(`${stage}/sites/${name}.caddy`, content);
		writeFileSync(
			`${stage}/Caddyfile`,
			live.replaceAll(`${sites}/`, `${stage}/sites/`),
		);
		const v = opts.validate(`${stage}/Caddyfile`);
		if (v.code !== 0) return { ok: false, stage: "validate", out: v.out };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
	const prior = existsSync(frag) ? readFileSync(frag, "utf8") : null;
	writeAtomic(frag, content);
	if (opts.served?.() === true) return { ok: true };
	const r = reloadWithRetry(caddyfile, opts.reload);
	if (r.code === 0) return { ok: true };
	if (prior === null) rmSync(frag, { force: true });
	else writeAtomic(frag, prior);
	return { ok: false, stage: "reload", out: r.out };
};

const caddyValidate = (): void => {
	const v = run([CADDY, "validate", "--config", CADDYFILE]);
	if (v.code !== 0) {
		console.error(`✗ caddy validate failed:\n${v.out}`);
		process.exit(1);
	}
};

const tryReload = (): void => {
	const r = run([CADDY, "reload", "--config", CADDYFILE]);
	if (r.code !== 0)
		console.log(
			`  warning: caddy reload failed (${r.out.split("\n")[0]}) — run: klh-local reload`,
		);
};

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const getifaddr = (iface: string): string => {
	if (!/^[a-z]+\d+$/.test(iface)) return "";
	const r = run([IPCONFIG, "getifaddr", iface]);
	return r.code === 0 && IPV4_RE.test(r.out) ? r.out : "";
};

// en0 is Wi-Fi on laptops but often Ethernet-less on desktops: try it, then
// the default-route interface, then scan the remaining en* interfaces.
export const lanIp = (): string => {
	const en0 = getifaddr("en0");
	if (en0) return en0;
	const route = run(["/sbin/route", "-n", "get", "default"]);
	const iface = /interface:\s*(\S+)/.exec(route.out)?.[1];
	const viaRoute = iface ? getifaddr(iface) : "";
	if (viaRoute) return viaRoute;
	for (let i = 1; i < 10; i++) {
		const ip = getifaddr(`en${i}`);
		if (ip) return ip;
	}
	return "";
};

// -P (register proxy) creates the A record + service so <name>.local actually
// resolves; -R alone registers a service into a name that never answers.
// Loopback services advertise 127.0.0.1 — never a LAN address nothing listens
// on; --lan services advertise the LAN address.
export const dnsArgv = (name: string, port: number, ip: string): string[] =>
	ip
		? [
				DNS_SD,
				"-P",
				name,
				"_http._tcp",
				"local",
				String(port),
				`${name}.local`,
				ip,
			]
		: [DNS_SD, "-R", name, "_http._tcp", `${name}.local`, String(port)];

// dns-sd must be spawned through a sh intermediary — as a direct Bun child it
// lives but never completes registration (measured 2026-09-28, belt lane).
// The script is a constant; dns-sd's argv travels as positional parameters.
const claimDns = (name: string, port: number, lan: boolean): Dns => {
	const p = Bun.spawn(
		[
			"/bin/sh",
			"-c",
			'exec "$@" </dev/null >/dev/null 2>&1',
			"sh",
			...dnsArgv(name, port, lan ? lanIp() : "127.0.0.1"),
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	p.unref();
	return { claimed: true, pid: p.pid };
};

const releaseDns = (dns: Dns): void => {
	if (dns.claimed && dns.pid && dnsAlive(dns.pid)) {
		try {
			process.kill(dns.pid, "SIGTERM");
		} catch {}
	}
};

const cmdInstall = (): void => {
	if (!existsSync(CADDY)) {
		if (!existsSync(BREW))
			die(
				`caddy missing and brew not found at ${BREW} — install Caddy, then re-run: klh-local install`,
			);
		console.log(`→ brew install caddy`);
		const b = Bun.spawnSync([BREW, "install", "caddy"], {
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (b.exitCode !== 0) die(`brew install caddy failed (exit ${b.exitCode})`);
		CADDY = caddyBin();
	}
	mkdirSync(SITES, { recursive: true });
	if (!existsSync(CADDYFILE)) writeFileSync(CADDYFILE, caddyfileSkeleton());
	writeFileSync(PLIST, plistConf());
	const uid = process.getuid();
	run(["/bin/launchctl", "bootout", `gui/${uid}/${LABEL}`]); // ignore "not loaded"
	const r = run(["/bin/launchctl", "bootstrap", `gui/${uid}`, PLIST]);
	if (r.code !== 0 && !r.out.includes("already bootstrapped"))
		die(`launchctl bootstrap failed:\n${r.out}`);
	run(["/bin/launchctl", "kickstart", `gui/${uid}/${LABEL}`]);
	const ver = run([CADDY, "version"]);
	console.log(`
✓ caddy serving as user LaunchAgent (${LABEL})

  caddy      ${ver.out.split("\n")[0] || "installed"}
  caddyfile  ${CADDYFILE}
  agent      ${PLIST} (RunAtLoad + KeepAlive)
  sites dir  ${SITES}/
  ports      :80/:443 bound unprivileged — zero root anywhere
  https      auto-HTTPS via Caddy internal CA — run once if browsers complain: caddy trust
`);
};

const cmdRegister = async (argv: string[]): Promise<void> => {
	let name = "";
	let portRaw = "";
	let healthPath = "/";
	let noDns = false;
	let lan = false;
	let forwardAuth = "";
	let upstream = "";
	const routes: Route[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port") portRaw = argv[++i] ?? "";
		else if (argv[i] === "--health") healthPath = argv[++i] ?? "/";
		else if (argv[i] === "--no-dns") noDns = true;
		else if (argv[i] === "--lan") lan = true;
		else if (argv[i] === "--forward-auth") forwardAuth = argv[++i] ?? "";
		else if (argv[i] === "--upstream") upstream = argv[++i] ?? "";
		else if (argv[i] === "--route") {
			const spec = argv[++i] ?? "";
			const eq = spec.lastIndexOf("=");
			const rawPath = eq > 0 ? spec.slice(0, eq) : "";
			const port = Number(eq > 0 ? spec.slice(eq + 1) : "");
			if (!rawPath.startsWith("/") || !/^[A-Za-z0-9/_.-]+$/.test(rawPath))
				die(
					`invalid --route path "${rawPath}" — must start with / (letters, digits, / _ . - only)`,
				);
			if (!Number.isInteger(port) || port < 1 || port > 65535)
				die(`invalid --route port in "${spec}"`);
			routes.push({
				path: rawPath.endsWith("*") ? rawPath : `${rawPath}*`,
				port,
			});
		} else if (!argv[i].startsWith("--") && !name) name = argv[i];
	}
	const port = Number(
		portRaw || (upstream ? (upstream.split(":")[1] ?? "80") : ""),
	);
	if (!name || (!portRaw && !upstream))
		die(
			`usage: klh-local register <name> --port N [--upstream HOST:PORT] [--health /health] [--no-dns] [--lan --forward-auth URL]`,
		);
	if (!NAME_RE.test(name))
		die(
			`invalid name "${name}" — must match ${NAME_RE} (lowercase, starts with a letter; letters/digits/hyphen)`,
		);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		die(`invalid port "${portRaw}"`);
	if (!healthPath.startsWith("/"))
		die(`invalid --health "${healthPath}" — must start with /`);
	if (lan && !forwardAuth)
		die(
			`--lan exposes ${name}.local beyond this Mac — it requires --forward-auth <url> (the SSO/auth endpoint Caddy asks before proxying)`,
		);
	if (forwardAuth && !lan)
		die(
			`--forward-auth only applies with --lan (loopback sites abort external remotes)`,
		);
	if (forwardAuth && !parseForwardAuth(forwardAuth))
		die(
			`invalid --forward-auth "${forwardAuth}" — http(s)://host[:port]/path, no credentials or fragment`,
		);
	if (upstream && !/^[a-z0-9.-]+(:\d{1,5})?$/.test(upstream))
		die(`invalid --upstream "${upstream}" — host[:port], lowercase host or IP`);
	if (upstream && lan)
		die(`--upstream composes with loopback sites only (drop --lan)`);
	const exposure: Exposure = upstream
		? { lan: false, upstream }
		: lan
			? { lan, forwardAuth }
			: { lan: false };
	// Probe before the registry lock (read-only): when the running instance
	// already serves name → target, the register converges without reloading —
	// a reload re-binds listeners, and on macOS a specific-address bind on a
	// privileged port is EACCES while a wildcard holder lives (W602).
	const target = exposure.upstream ?? `127.0.0.1:${port}`;
	const active = await fetchActiveConfig();
	const alreadyServed =
		active !== null && activeRouteMatches(active, `${name}.local`, target);
	withRegistryLock(() =>
		registerLocked(
			name,
			port,
			healthPath,
			noDns,
			routes,
			exposure,
			alreadyServed,
		),
	);
};

const registerLocked = (
	name: string,
	port: number,
	healthPath: string,
	noDns: boolean,
	routes: Route[],
	exposure: Exposure,
	alreadyServed: boolean,
): void => {
	const reg = readRegistry();
	const existing = reg.find((s) => s.name === name);
	// idempotent re-register: same name+port converges (install scripts re-run);
	// a port change is a different service contract — require explicit deregister.
	if (
		existing &&
		(existing.port !== port || existing.health_path !== healthPath)
	)
		die(
			`already registered as ${name} → :${existing.port}${existing.health_path} — to change: klh-local deregister ${name}, then register`,
		);
	if (!existing && !exposure.upstream && reg.some((s) => s.port === port))
		die(
			`port ${port} already registered (${reg.find((s) => s.port === port)?.name})`,
		);
	if (!existsSync(CADDY)) die(`caddy missing — run: klh-local install`);
	if (!existsSync(CADDYFILE))
		die(`no Caddyfile at ${CADDYFILE} — run: klh-local install`);

	mkdirSync(SITES, { recursive: true });
	const frag = fragmentPath(name);

	console.log(
		alreadyServed
			? `→ caddy validate (staged) → reload skipped (the running instance already serves this route)`
			: `→ caddy validate (staged) → caddy reload (user-level, zero downtime)`,
	);
	const res = applyFragment({
		sites: SITES,
		caddyfile: CADDYFILE,
		name,
		content: fragmentConf(name, port, routes, exposure),
		validate: (cf) => run([CADDY, "validate", "--config", cf]),
		reload: (cf, force) =>
			run([CADDY, "reload", ...(force ? ["--force"] : []), "--config", cf]),
		served: () => alreadyServed,
	});
	if (!res.ok) {
		if (res.stage === "validate")
			die(`caddy validate failed (sites/ untouched):\n${res.out}`);
		const rolled = existing ? "prior fragment restored" : "fragment removed";
		if (res.out.includes("connection refused") || res.out.includes("admin API"))
			die(`caddy not reachable — run: klh-local install (${rolled})`);
		die(`caddy reload failed (${rolled}):\n${res.out}`);
	}

	// reuse a live dns claim — a second claimant on the same name makes the two
	// registrations conflict-rename each other (belt-2 problems). An exposure
	// change re-claims: the advertised address differs.
	const sameExposure = Boolean(existing?.lan) === exposure.lan;
	if (existing && !sameExposure) releaseDns(existing.dns);
	const dns =
		existing?.dns.claimed && sameExposure && dnsAlive(existing.dns.pid)
			? existing.dns
			: noDns
				? ({ claimed: false } as Dns)
				: claimDns(name, port, exposure.lan);
	saveRegistry([
		...reg.filter((s) => s.name !== name),
		{
			name,
			port,
			health_path: healthPath,
			routes: routes.length ? routes : undefined,
			lan: exposure.lan || undefined,
			forward_auth: exposure.lan ? exposure.forwardAuth : undefined,
			upstream: exposure.upstream,
			dns,
			caddy: { conf_path: frag },
			created_at: existing?.created_at ?? new Date().toISOString(),
		},
	]);

	console.log(`
✓ ${name} ${existing ? "re-registered (converged)" : "registered"}

  https://${name}.local/           caddy → 127.0.0.1:${port} (auto-HTTPS)
  http://${name}.local/            caddy → 127.0.0.1:${port}
  http://${name}.local:${port}/    direct
  exposure ${exposure.lan ? `LAN, behind forward_auth ${exposure.forwardAuth}` : "loopback only (external remotes aborted)"}
${
	routes.length
		? routes
				.map(
					(r) => `  route     ${r.path} → 127.0.0.1:${r.port} (path preserved)`,
				)
				.join("\n")
		: ""
}
  dns      ${dns.claimed ? `claimed by dns-sd (pid ${dns.pid})` : `skipped (--no-dns)`}
  fragment ${frag}
`);
	if (!hostsHave(name))
		console.log(
			`  hosts    entry missing — apply with: sudo klh-local hosts-apply`,
		);
};

const cmdList = (): void => {
	const reg = readRegistry();
	if (reg.length === 0) {
		console.log("no services registered");
		return;
	}
	const w = Math.max(...reg.map((s) => s.name.length), 4);
	for (const s of reg) {
		const dns = s.dns.claimed
			? dnsAlive(s.dns.pid)
				? `pid ${s.dns.pid}`
				: `dead (pid ${s.dns.pid})`
			: "—";
		console.log(
			`${s.name.padEnd(w)}  :${String(s.port).padEnd(5)}  http://${s.name}.local/  ${s.lan ? "lan " : "loop"}  dns: ${dns.padEnd(14)}  ${s.created_at.slice(0, 10)}`,
		);
		if (s.routes?.length)
			console.log(
				`  ${"".padEnd(w)}routes: ${s.routes.map((r) => `${r.path} → 127.0.0.1:${r.port}`).join("  ")}`,
			);
	}
};

const cmdStatus = async (): Promise<void> => {
	const reg = readRegistry();
	if (reg.length === 0) {
		console.log("no services registered");
		return;
	}
	for (const s of reg) {
		const target = serviceTarget(s);
		const h = await probeService(
			target,
			s.health_path,
			1500,
			`${s.name}.local`,
		);
		const dns = s.dns.claimed
			? dnsAlive(s.dns.pid)
				? `alive (pid ${s.dns.pid})`
				: `DEAD (pid ${s.dns.pid} gone)`
			: `not claimed (--no-dns)`;
		const conf = existsSync(s.caddy.conf_path)
			? s.caddy.conf_path
			: `MISSING — ${s.caddy.conf_path}`;
		console.log(`${s.name}  https://${s.name}.local/ → ${target}`);
		console.log(
			`  health   ${h.ok ? `ok HTTP ${h.code} ${h.ms}ms` : `fail ${h.ms}ms`}  (GET ${target}${s.health_path})`,
		);
		console.log(`  dns      ${dns}`);
		console.log(
			`  exposure ${s.lan ? `LAN, forward_auth ${s.forward_auth}` : "loopback only"}`,
		);
		console.log(`  fragment ${conf}`);
		if (s.routes?.length)
			console.log(
				`  routes   ${s.routes.map((r) => `${r.path} → 127.0.0.1:${r.port}`).join("  ")}`,
			);
		console.log("");
	}
};

const cmdDeregister = (name: string): void => {
	if (!name) die(`usage: klh-local deregister <name>`);
	withRegistryLock(() => {
		const reg = readRegistry();
		const entry = reg.find((s) => s.name === name);
		if (!entry) return die(`not registered: ${name}`);
		rmSync(entry.caddy.conf_path, { force: true });
		releaseDns(entry.dns);
		saveRegistry(reg.filter((s) => s.name !== name));
	});
	console.log(`✓ ${name} deregistered (fragment removed, dns claim released)`);
	if (hostsHave(name))
		console.log(
			`  hosts    stale entry remains — refresh with: sudo klh-local hosts-apply`,
		);
	console.log(`→ caddy reload`);
	tryReload();
};

const hostsHave = (name: string): boolean => {
	try {
		return readFileSync(HOSTS, "utf8").includes(`127.0.0.1 ${name}.local`);
	} catch {
		return false;
	}
};

// /etc/hosts cannot wildcard, and macOS sends *.local to mDNS — a dnsmasq
// catch-all would hijack printer/AirPlay .local names machine-wide. So: exact
// names, one marked block, regenerated from the registry. The one sudo here.
// Under sudo HOME may be root's — the registry belongs to the invoking user.
export const hostsRegistryPath = (
	argv: string[],
	env: Record<string, string | undefined>,
	homeOf: (user: string) => string,
): string => {
	const i = argv.indexOf("--registry");
	if (i >= 0) return argv[i + 1] ?? die("--registry needs a path");
	const user = env.SUDO_USER;
	if (user && user !== "root" && /^[A-Za-z0-9._-]+$/.test(user))
		return `${homeOf(user)}/.local/state/klh-local/registry.json`;
	return REGISTRY;
};

const userHome = (user: string): string => {
	const r = run([
		"/usr/bin/dscl",
		".",
		"-read",
		`/Users/${user}`,
		"NFSHomeDirectory",
	]);
	const m = /NFSHomeDirectory:\s*(\S+)/.exec(r.out);
	return r.code === 0 && m ? m[1] : `/Users/${user}`;
};

const cmdHostsApply = (argv: string[]): void => {
	if (process.getuid() !== 0)
		die(
			`hosts-apply rewrites ${HOSTS} — run it under sudo: sudo klh-local hosts-apply`,
		);
	const registry = hostsRegistryPath(argv, process.env, userHome);
	if (!existsSync(registry))
		die(
			`no registry at ${registry} — refusing to clear the managed block (pass --registry PATH)`,
		);
	const reg = readRegistryAt(registry);
	const target = realpathSync(HOSTS); // /etc/hosts → /private/etc/hosts on macOS
	const cur = readFileSync(target, "utf8");
	const re = new RegExp(`${HOSTS_START}[\\s\\S]*?${HOSTS_END}\\n?`);
	const block = reg.length
		? `${HOSTS_START}\n${reg.map((s) => `127.0.0.1 ${s.name}.local`).join("\n")}\n${HOSTS_END}\n`
		: "";
	const next = block
		? `${cur
				.replace(re, "")
				.replace(/\n{3,}/g, "\n\n")
				.replace(/\n*$/, "\n\n")}${block}`
		: cur.replace(re, "").replace(/\n{3,}/g, "\n\n");
	if (next === cur) {
		console.log(`hosts: already current (${reg.length} managed names)`);
		return;
	}
	writeAtomic(target, next, statSync(target).mode & 0o777);
	console.log(
		reg.length
			? `hosts: managed block written (${reg.length} names)`
			: "hosts: managed block removed",
	);
	for (const s of reg) console.log(`  127.0.0.1 ${s.name}.local`);
};

const cmdReload = (): void => {
	if (!existsSync(CADDY)) die(`caddy missing — run: klh-local install`);
	console.log(`→ caddy validate`);
	caddyValidate();
	console.log(`→ caddy reload`);
	const r = reloadWithRetry(CADDYFILE, (cf, force) =>
		run([CADDY, "reload", ...(force ? ["--force"] : []), "--config", cf]),
	);
	if (r.code !== 0) {
		if (r.out.includes("connection refused") || r.out.includes("admin API"))
			die(`caddy not reachable — run: klh-local install`);
		die(`caddy reload failed:\n${r.out}`);
	}
};

const dnsProcessMatches = (pid: number, argv: string[]): boolean => {
	const args = run(["/bin/ps", "-p", String(pid), "-o", "args="]);
	return args.code === 0 && args.out.split(/\s+/).join(" ") === argv.join(" ");
};

const cmdDnsReconcile = async (
	name: string,
	options?: {
		owned: Map<string, { pid: number; argv: string[] }>;
		stopped: () => boolean;
	},
): Promise<void> => {
	if (!NAME_RE.test(name))
		die("usage: klh-local dns-reconcile <registered-name>");
	const existing = readRegistry().find((service) => service.name === name);
	if (!existing) throw new Error(`not registered: ${name}`);
	if (options && !existing.dns.claimed) return;
	const target = serviceTarget(existing);
	const active = await fetchActiveConfig();
	if (active === null || !activeRouteMatches(active, `${name}.local`, target))
		throw new Error(
			"active Caddy route does not match registry; DNS unchanged",
		);
	if (options?.stopped()) return;
	withRegistryLock(() => {
		const registry = readRegistry();
		const current = registry.find((service) => service.name === name);
		if (!current || JSON.stringify(current) !== JSON.stringify(existing))
			throw new Error(
				"registry changed during route verification; retry DNS reconciliation",
			);
		const expected = dnsArgv(
			name,
			current.port,
			current.lan ? lanIp() : "127.0.0.1",
		);
		const matches = (pid: number): boolean => dnsProcessMatches(pid, expected);
		const result = reconcileDnsClaim({
			current: current.dns,
			matches,
			spawn: () => {
				const claim = claimDns(name, current.port, Boolean(current.lan));
				for (let attempt = 0; attempt < 10; attempt++) {
					if (claim.pid && matches(claim.pid)) break;
					Bun.sleepSync(100);
				}
				return claim;
			},
			publish: (claim) => {
				current.dns = claim;
				saveRegistry(registry);
				if (options && claim.pid)
					options.owned.set(name, { pid: claim.pid, argv: expected });
			},
			cleanupNew: (pid) => {
				if (matches(pid)) process.kill(pid, "SIGTERM");
			},
		});
		if (!options || result === "reconciled")
			console.log(
				`✓ ${name} DNS ${result}; Caddy listeners and routes unchanged`,
			);
	});
};

const cmdDnsServe = async (): Promise<void> => {
	const owned = new Map<string, { pid: number; argv: string[] }>();
	let stopped = false;
	const stop = (): void => {
		stopped = true;
		releaseOwnedClaims({
			owned,
			currentPid: (name) =>
				readRegistry().find((row) => row.name === name)?.dns.pid,
			matches: dnsProcessMatches,
			terminate: (pid) => {
				try {
					process.kill(pid, "SIGTERM");
				} catch {}
			},
		});
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	while (!stopped) {
		await maintainDnsClaims({
			registrations: readRegistry(),
			reconcile: (name) =>
				cmdDnsReconcile(name, { owned, stopped: () => stopped }),
			onError: (name, error) => console.error(`DNS ${name}: ${String(error)}`),
		});
		for (let elapsed = 0; !stopped && elapsed < 30; elapsed++)
			await Bun.sleep(1000);
	}
};

const usage = `klh-local — one command per local service

  install                          caddy + user LaunchAgent + Caddyfile skeleton
  register <name> --port N [--health /health] [--no-dns] [--route /path=port]
           [--lan --forward-auth URL]  loopback-only by default; --lan exposes on the LAN behind forward_auth
  deregister <name>                remove fragment, release dns claim, forget
  list                             registry table
  status                           health + dns + fragment per service
  reload                           caddy validate + reload (user-level, zero downtime)
  dns-reconcile <name>             restore registered mDNS claim without reloading Caddy
  dns-serve                        restore enabled DNS claims at login and after claim loss
  hosts-apply [--registry PATH]    rewrite the managed /etc/hosts block from the registry (sudo)`;

if (import.meta.main) {
	const [cmd, ...rest] = process.argv.slice(2);
	if (cmd === "install") cmdInstall();
	else if (cmd === "register") await cmdRegister(rest);
	else if (cmd === "list") cmdList();
	else if (cmd === "status") await cmdStatus();
	else if (cmd === "deregister") cmdDeregister(rest[0] ?? "");
	else if (cmd === "reload") cmdReload();
	else if (cmd === "dns-reconcile") await cmdDnsReconcile(rest[0] ?? "");
	else if (cmd === "dns-serve") await cmdDnsServe();
	else if (cmd === "hosts-apply") cmdHostsApply(rest);
	else {
		console.log(usage);
		process.exit(cmd ? 1 : 0);
	}
}
