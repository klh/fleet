#!/usr/bin/env bun
// klh-local.ts — one command per local service: Caddy site + dns-sd claim + registry.
//   bun klh-local.ts install
//   bun klh-local.ts register <name> --port N [--health /p] [--no-dns]
//   bun klh-local.ts list | status | deregister <name> | reload
//   sudo bun klh-local.ts hosts-apply

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";

const die = (msg: string): never => {
	console.error(`✗ ${msg}`);
	return process.exit(1) as never;
};

const HOME = process.env.HOME ?? die("HOME unset");
const CADDY = "/opt/homebrew/bin/caddy";
const BREW = "/opt/homebrew/bin/brew";
const DNS_SD = "/usr/bin/dns-sd";
const STATE = `${HOME}/.local/state/klh-local`;
const SITES = `${STATE}/sites`;
const CADDYFILE = `${STATE}/Caddyfile`;
const fragmentPath = (name: string): string => `${SITES}/${name}.caddy`;
const PLIST = `${HOME}/Library/LaunchAgents/com.klh-local.caddy.plist`;
const LABEL = "com.klh-local.caddy";
const REGISTRY = `${STATE}/registry.json`;
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const HOSTS = "/etc/hosts";
const HOSTS_START = "# --- klh-local managed: start ---";
const HOSTS_END = "# --- klh-local managed: end ---";

type Dns = { claimed: boolean; pid?: number };
type Route = { path: string; port: number };
type Service = {
	name: string;
	port: number;
	health_path: string;
	routes?: Route[];
	dns: Dns;
	caddy: { conf_path: string };
	created_at: string;
};
type Registry = Service[];

const readRegistry = (): Registry => {
	if (!existsSync(REGISTRY)) return [];
	try {
		return JSON.parse(readFileSync(REGISTRY, "utf8")) as Registry;
	} catch {
		return die(`registry unreadable: ${REGISTRY} (fix or remove it)`);
	}
};

const saveRegistry = (reg: Registry): void => {
	mkdirSync(STATE, { recursive: true });
	const tmp = `${REGISTRY}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
	renameSync(tmp, REGISTRY);
};

const run = (argv: string[]): { code: number; out: string } => {
	const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	const out =
		`${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`.trim();
	return { code: p.exitCode ?? 1, out };
};

const dnsAlive = (pid?: number): boolean => {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const fragmentConf = (
	name: string,
	port: number,
	routes: Route[] = [],
): string => {
	const header = `# klh-local fragment — https://${name}.local/ → 127.0.0.1:${port} (auto-HTTPS via Caddy internal CA)`;
	if (routes.length === 0)
		return `${header}
${name}.local {
	reverse_proxy 127.0.0.1:${port}
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
${handles}	handle {
		reverse_proxy 127.0.0.1:${port}
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

// -P (register proxy) creates the A record + service so <name>.local actually
// resolves; -R alone registers a service into a name that never answers.
// dns-sd must be spawned through a sh intermediary — as a direct Bun child it
// lives but never completes registration (measured 2026-09-28, belt lane).
const claimDns = (name: string, port: number): Dns => {
	let ip = "";
	try {
		ip = run(["/usr/sbin/ipconfig", "getifaddr", "en0"]).out.trim();
	} catch {}
	const mdnsHost = (ip: string): string[] =>
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
	const p = Bun.spawn(
		[
			"/bin/sh",
			"-c",
			`exec ${mdnsHost(ip).join(" ")} </dev/null >/dev/null 2>&1`,
		],
		{
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	p.unref();
	return { claimed: true, pid: p.pid };
};

const healthCheck = async (
	port: number,
	path: string,
): Promise<{ ok: boolean; ms: number; code?: number }> => {
	const t0 = performance.now();
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, {
			signal: AbortSignal.timeout(1500),
		});
		return { ok: true, ms: Math.round(performance.now() - t0), code: r.status };
	} catch {
		return { ok: false, ms: Math.round(performance.now() - t0) };
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

const cmdRegister = (argv: string[]): void => {
	let name = "";
	let portRaw = "";
	let healthPath = "/";
	let noDns = false;
	const routes: Route[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--port") portRaw = argv[++i] ?? "";
		else if (argv[i] === "--health") healthPath = argv[++i] ?? "/";
		else if (argv[i] === "--no-dns") noDns = true;
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
	const port = Number(portRaw);
	if (!name || !portRaw)
		die(
			`usage: klh-local register <name> --port N [--health /health] [--no-dns]`,
		);
	if (!NAME_RE.test(name))
		die(
			`invalid name "${name}" — must match ${NAME_RE} (lowercase, starts with a letter; letters/digits/hyphen)`,
		);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		die(`invalid port "${portRaw}"`);
	if (!healthPath.startsWith("/"))
		die(`invalid --health "${healthPath}" — must start with /`);
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
	if (!existing && reg.some((s) => s.port === port))
		die(
			`port ${port} already registered (${reg.find((s) => s.port === port)?.name})`,
		);
	if (!existsSync(CADDY)) die(`caddy missing — run: klh-local install`);
	if (!existsSync(CADDYFILE))
		die(`no Caddyfile at ${CADDYFILE} — run: klh-local install`);

	mkdirSync(SITES, { recursive: true });
	const frag = fragmentPath(name);
	writeFileSync(frag, fragmentConf(name, port, routes));

	console.log(`→ caddy validate`);
	caddyValidate();
	console.log(`→ caddy reload (user-level, zero downtime)`);
	const r = run([CADDY, "reload", "--config", CADDYFILE]);
	if (r.code !== 0) {
		rmSync(frag, { force: true });
		if (r.out.includes("connection refused") || r.out.includes("admin API"))
			die(
				`caddy not reachable — run: klh-local install (fragment rolled back)`,
			);
		die(`caddy reload failed (fragment rolled back):\n${r.out}`);
	}

	// reuse a live dns claim — a second claimant on the same name makes the two
	// registrations conflict-rename each other (belt-2 problems)
	const dns =
		existing?.dns.claimed && dnsAlive(existing.dns.pid)
			? existing.dns
			: noDns
				? ({ claimed: false } as Dns)
				: claimDns(name, port);
	saveRegistry([
		...reg.filter((s) => s.name !== name),
		{
			name,
			port,
			health_path: healthPath,
			routes: routes.length ? routes : undefined,
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
			`${s.name.padEnd(w)}  :${String(s.port).padEnd(5)}  http://${s.name}.local/  dns: ${dns.padEnd(14)}  ${s.created_at.slice(0, 10)}`,
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
		const h = await healthCheck(s.port, s.health_path);
		const dns = s.dns.claimed
			? dnsAlive(s.dns.pid)
				? `alive (pid ${s.dns.pid})`
				: `DEAD (pid ${s.dns.pid} gone)`
			: `not claimed (--no-dns)`;
		const conf = existsSync(s.caddy.conf_path)
			? s.caddy.conf_path
			: `MISSING — ${s.caddy.conf_path}`;
		console.log(`${s.name}  https://${s.name}.local/ → 127.0.0.1:${s.port}`);
		console.log(
			`  health   ${h.ok ? `ok HTTP ${h.code} ${h.ms}ms` : `fail ${h.ms}ms`}  (GET 127.0.0.1:${s.port}${s.health_path})`,
		);
		console.log(`  dns      ${dns}`);
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
	const reg = readRegistry();
	const entry = reg.find((s) => s.name === name);
	if (!entry) die(`not registered: ${name}`);
	rmSync(entry.caddy.conf_path, { force: true });
	if (entry.dns.claimed && entry.dns.pid && dnsAlive(entry.dns.pid)) {
		try {
			process.kill(entry.dns.pid, "SIGTERM");
		} catch {}
	}
	saveRegistry(reg.filter((s) => s.name !== name));
	console.log(`✓ ${name} deregistered (fragment removed, dns claim killed)`);
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
const cmdHostsApply = (): void => {
	if (process.getuid() !== 0)
		die(
			`hosts-apply rewrites ${HOSTS} — run it under sudo: sudo klh-local hosts-apply`,
		);
	const reg = readRegistry();
	const cur = readFileSync(HOSTS, "utf8");
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
	writeFileSync(HOSTS, next);
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
	const r = run([CADDY, "reload", "--config", CADDYFILE]);
	if (r.code !== 0) {
		if (r.out.includes("connection refused") || r.out.includes("admin API"))
			die(`caddy not reachable — run: klh-local install`);
		die(`caddy reload failed:\n${r.out}`);
	}
};

const usage = `klh-local — one command per local service

  install                          caddy + user LaunchAgent + Caddyfile skeleton
  register <name> --port N [--health /health] [--no-dns] [--route /path=port]
  deregister <name>                remove fragment, kill dns claim, forget
  list                             registry table
  status                           health + dns + fragment per service
  reload                           caddy validate + reload (user-level, zero downtime)
  hosts-apply                      rewrite the managed /etc/hosts block from the registry (sudo)`;

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "install") cmdInstall();
else if (cmd === "register") cmdRegister(rest);
else if (cmd === "list") cmdList();
else if (cmd === "status") await cmdStatus();
else if (cmd === "deregister") cmdDeregister(rest[0] ?? "");
else if (cmd === "reload") cmdReload();
else if (cmd === "hosts-apply") cmdHostsApply();
else {
	console.log(usage);
	process.exit(cmd ? 1 : 0);
}
