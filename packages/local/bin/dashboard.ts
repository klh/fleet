#!/usr/bin/env bun
// dashboard.ts — klh-local bar: the registry, rendered live on :7792.
// One read-only status board for the services klh-local manages. All data
// derives from the same registry.json the CLI reads: configured GET (1.5s
// timeout) against the registered upstream, with reachability distinct from 2xx,
// dns-claim liveness (the recorded pid must still be dns-sd), fragment presence on
// disk. GET / serves an offline Lit page (auto-refresh 3s); GET
// /api/status is the JSON behind it; GET /llms.txt is the plain-text intro.
// The board itself registers nothing and reloads nothing — the `bar` service
// name is claimed by `klh-local register bar`, exactly like any other service.
// Page styling follows the threads.dk instrument spec: warm near-black ground,
// mono throughout, one rust accent, hairline rows not cards.
//
// Usage:
//   bun dashboard.ts                  — serve on :7792 (KLH_LOCAL_BAR_PORT /
//                                       BELT_BAR_PORT overrides)
//   curl 127.0.0.1:7792/api/status    — raw snapshot
//   curl 127.0.0.1:7792/llms.txt      — what this is, in plain text

import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { basename } from "node:path";
import {
	probeService,
	serviceTarget,
	type HealthObservation,
} from "./dashboard-health.ts";
import {
	THEME_HEAD,
	THEME_SETTINGS_CSS,
	THEME_SETTINGS_JS,
	FLEET_NAV_CSS,
	fleetNav,
	settingsBlock,
} from "./klh-theme.ts";

const HOME = process.env.HOME ?? "";
const STATE = `${HOME}/.local/state/klh-local`;
const REGISTRY = `${STATE}/registry.json`;
// what /api/status shows — never the absolute path (it carries the username)
const REGISTRY_DISPLAY = "~/.local/state/klh-local/registry.json";
const CADDY =
	Bun.which("caddy") ??
	["/opt/homebrew/bin/caddy", "/usr/local/bin/caddy"].find((p) =>
		existsSync(p),
	) ??
	"caddy";
// Loopback only: Caddy fronts bar.local; these are the Hosts it may arrive as.
const HOSTS_OK = new Set(["127.0.0.1", "localhost", "[::1]", "bar.local"]);
const PORT = Number(
	process.env.KLH_LOCAL_BAR_PORT ?? process.env.BELT_BAR_PORT ?? 7792,
);

// ─── registry — same shape bin/klh-local.ts writes ───
type Dns = { claimed: boolean; pid?: number };
type Service = {
	name: string;
	port: number;
	health_path: string;
	dns: Dns;
	caddy: { conf_path: string };
	created_at: string;
	upstream?: string;
};

const run = (argv: string[]): string => {
	try {
		const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
		return `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`.trim();
	} catch {
		return "";
	}
};

// same liveness test the status verb uses: the pid must still be dns-sd —
// after a reboot a recorded pid can belong to any unrelated process
const dnsAlive = (pid?: number): boolean => {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	const p = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "comm="], {
		stdout: "pipe",
		stderr: "ignore",
	});
	return (
		p.exitCode === 0 && basename(p.stdout?.toString().trim() ?? "") === "dns-sd"
	);
};

// is anything answering on the port? pure TCP — the catch-all Caddy block
// `abort`s unknown Hosts, so an HTTP probe of :80 would read as an error
// even while Caddy is serving.
const portAnswering = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const s = connect({ host: "127.0.0.1", port });
		const done = (v: boolean): void => {
			s.destroy();
			resolve(v);
		};
		s.setTimeout(1000, () => done(false));
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
	});

// ─── status snapshot ───
type ServiceRow = {
	name: string;
	port: number;
	target: string;
	health: HealthObservation;
	health_path: string;
	upstream?: string;
	dns: { claimed: boolean; pid: number | null; alive: boolean };
	fragment: boolean;
	created_at: string | null;
};

type Snapshot = {
	caddy: { listening: boolean; version: string };
	registry: string;
	services: ServiceRow[];
	error: string | null;
	ts: string;
};

async function status(): Promise<Snapshot> {
	let reg: Service[] = [];
	let error: string | null = null;
	try {
		if (existsSync(REGISTRY)) {
			const parsed = JSON.parse(readFileSync(REGISTRY, "utf8"));
			if (
				!Array.isArray(parsed) ||
				parsed.some(
					(service) =>
						!service ||
						typeof service.name !== "string" ||
						!Number.isInteger(service.port) ||
						service.port < 1 ||
						service.port > 65535,
				)
			)
				throw new Error("Invalid registry shape");
			reg = parsed as Service[];
		}
	} catch {
		error = `registry unreadable: ${REGISTRY_DISPLAY}`;
	}

	// caddy version is a subprocess call — cheap, but no reason to pay it on
	// every 3s tick; refresh at most once a minute.
	const caddy = {
		listening: await portAnswering(80),
		version: caddyVersion(),
	};

	const services = await Promise.all(
		reg.map(async (s) => ({
			name: s.name,
			port: s.port,
			target: serviceTarget(s),
			health_path: s.health_path ?? "/",
			upstream: s.upstream,
			health: await probeService(serviceTarget(s), s.health_path ?? "/"),
			dns: {
				claimed: Boolean(s.dns?.claimed),
				pid: s.dns?.pid ?? null,
				alive: dnsAlive(s.dns?.pid),
			},
			fragment: existsSync(s.caddy?.conf_path ?? ""),
			created_at: s.created_at ?? null,
		})),
	);

	return {
		caddy,
		registry: REGISTRY_DISPLAY,
		services,
		error,
		ts: new Date().toISOString(),
	};
}

let versionCache = { at: 0, text: "" };
const caddyVersion = (): string => {
	if (Date.now() - versionCache.at > 60_000)
		versionCache = { at: Date.now(), text: run([CADDY, "version"]) };
	return versionCache.text;
};

// The page and vendored Lit runtime are shipped beside this server by install.sh.
const PAGE = (
	await Bun.file(new URL("./dashboard-page.html", import.meta.url)).text()
)
	.replace("<!-- THEME_HEAD -->", THEME_HEAD)
	.replace("/* THEME_CHROME_CSS */", `${FLEET_NAV_CSS}\n${THEME_SETTINGS_CSS}`)
	.replace("<!-- FLEET_NAV -->", `${fleetNav("local")}${settingsBlock()}`)
	.replace("/* THEME_SETTINGS_JS */", THEME_SETTINGS_JS);
const LIT = Bun.file(new URL("./vendor/lit-shared.js", import.meta.url));

// ─── llms.txt — the plain-text intro ───
const LLMS = `# klh-local

One command per local service on macOS. \`klh-local register <name> --port N\`
writes a Caddy site fragment, claims <name>.local over mDNS (dns-sd), records
the service in a registry file, and reloads Caddy — a user-level LaunchAgent,
zero sudo, zero downtime. The catch-all Caddy block aborts every Host no
fragment claims: default-deny for anything unregistered.

## Verbs

  install                caddy (brew, if missing) + Caddyfile + user LaunchAgent
  register <name> --port N [--health /p] [--no-dns] [--lan --forward-auth URL]
                         loopback-only by default; --lan is opt-in and authenticated
  deregister <name>      remove fragment, release dns claim, forget
  list                   registry table
  status                 health + dns + fragment per service (read-only)
  reload                 caddy validate + reload
  hosts-apply            rewrite the managed /etc/hosts block (sudo)

## Registry

~/.local/state/klh-local/registry.json — one JSON array: name, port,
health_path, dns claim (pid), caddy fragment path, created_at.

This page is the bar: the registry rendered live on :${PORT}, fronted by Caddy
at http://bar.local/. GET /api/status is the same snapshot as JSON.

https://github.com/klh/fleet/tree/main/packages/local

a Threads thing — http://www.threads.dk
`;

// ─── server ───
const json = (x: unknown): Response =>
	new Response(JSON.stringify(x, null, 2), {
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
		},
	});

Bun.serve({
	port: PORT,
	hostname: "127.0.0.1",
	async fetch(req): Promise<Response> {
		// DNS-rebind guard: a page on evil.example resolved to 127.0.0.1 still
		// carries its own Host header.
		const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
		if (!HOSTS_OK.has(host))
			return new Response("unknown host\n", { status: 421 });
		const path = new URL(req.url).pathname;
		if (path === "/vendor/lit-shared.js")
			return new Response(LIT, {
				headers: { "content-type": "text/javascript" },
			});
		if (path === "/api/status") return json(await status());
		if (path === "/llms.txt")
			return new Response(LLMS, {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		if (path === "/")
			return new Response(PAGE, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		return new Response("not found\n", { status: 404 });
	},
});

console.log(
	`klh-local bar → http://127.0.0.1:${PORT} (loopback only; via caddy: https://bar.local/)`,
);
