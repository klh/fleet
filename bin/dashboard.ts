#!/usr/bin/env bun
// dashboard.ts — klh-local bar: the registry, rendered live on :7792.
// One read-only status board for the services klh-local manages. All data
// derives from the same registry.json the CLI reads and the same probes the
// status verb uses: health GET (1.5s timeout) against 127.0.0.1:<port>,
// dns-claim liveness via kill -0 on the recorded pid, fragment presence on
// disk. GET / serves an embedded page (vanilla JS, auto-refresh 3s); GET
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

const HOME = process.env.HOME ?? "";
const STATE = `${HOME}/.local/state/klh-local`;
const REGISTRY = `${STATE}/registry.json`;
const CADDY = "/opt/homebrew/bin/caddy";
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
};

const run = (argv: string[]): string => {
	try {
		const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
		return `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}`.trim();
	} catch {
		return "";
	}
};

// kill -0 — same liveness test the status verb uses
const dnsAlive = (pid?: number): boolean => {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
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

// health — identical probe to the status verb: any HTTP response counts
// (the port answered), 1.5s timeout, latency recorded either way.
const healthCheck = async (
	port: number,
	path: string,
): Promise<{ ok: boolean; code?: number; ms: number }> => {
	const t0 = performance.now();
	try {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, {
			signal: AbortSignal.timeout(1500),
		});
		return {
			ok: true,
			code: r.status,
			ms: Math.round(performance.now() - t0),
		};
	} catch {
		return { ok: false, ms: Math.round(performance.now() - t0) };
	}
};

// ─── status snapshot ───
type ServiceRow = {
	name: string;
	port: number;
	target: string;
	health: { ok: boolean; code?: number; ms: number };
	dns: { claimed: boolean; pid: number | null; alive: boolean };
	fragment: string | null;
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
		if (existsSync(REGISTRY))
			reg = JSON.parse(readFileSync(REGISTRY, "utf8")) as Service[];
	} catch {
		error = `registry unreadable: ${REGISTRY}`;
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
			target: `127.0.0.1:${s.port}`,
			health: await healthCheck(s.port, s.health_path ?? "/"),
			dns: {
				claimed: Boolean(s.dns?.claimed),
				pid: s.dns?.pid ?? null,
				alive: dnsAlive(s.dns?.pid),
			},
			fragment: existsSync(s.caddy?.conf_path ?? "") ? s.caddy.conf_path : null,
			created_at: s.created_at ?? null,
		})),
	);

	return {
		caddy,
		registry: REGISTRY,
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

// ─── page — embedded, no frameworks, no external assets (works offline) ───
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bar — klh-local services</title>
<style>
:root { color-scheme: dark; --ground:#191614; --panel:#201d1a; --text:#e8e2d9; --mut:#8a857e;
  --rust:#e05a2b; --ok:#4a7c4e; --hair:rgba(232,226,217,.12); }
* { box-sizing: border-box; }
body { background:var(--ground); color:var(--text); font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace; margin:0; padding:18px 22px 26px; }
header { display:flex; align-items:baseline; gap:10px; margin-bottom:6px; }
header .mark { font-weight:700; font-size:13px; }
header .sub { color:var(--mut); font-size:11px; }
header .right { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:11px; color:var(--mut); font-variant-numeric:tabular-nums; }
.dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--rust); }
.blink { animation:blip 1s steps(1,end) infinite; }
@keyframes blip { 0%{opacity:1} 50%{opacity:.15} 100%{opacity:1} }
h2 { font-size:10px; font-weight:400; text-transform:uppercase; letter-spacing:.14em; color:var(--mut); margin:20px 0 2px; }
table { width:100%; border-collapse:collapse; }
th { text-align:left; font-weight:400; font-size:10px; text-transform:uppercase; letter-spacing:.14em; color:var(--mut); padding:8px 8px 6px 0; border-bottom:1px solid var(--hair); }
td { padding:9px 8px 9px 0; border-bottom:1px solid var(--hair); font-size:12.5px; }
td.r, th.r { text-align:right; padding-right:0; }
.mut { color:var(--mut); }
.ok { color:var(--ok); }
.bad { color:var(--rust); }
a { color:var(--mut); text-decoration:none; border-bottom:1px solid var(--hair); }
a:hover { color:var(--rust); border-bottom-color:var(--rust); }
.scroll { overflow-x:auto; }
#registryline { font-size:11px; color:var(--mut); margin:6px 0 0; }
#registryline .u { font-variant-numeric:tabular-nums; }
footer { border-top:1px solid var(--hair); margin-top:22px; padding-top:12px; display:flex; align-items:center; font-size:11px; color:var(--mut); }
footer .right { margin-left:auto; font-size:10px; letter-spacing:.14em; text-transform:uppercase; }
.empty { color:var(--mut); margin:8px 0 0; }
</style></head>
<body>
<header><span class="mark">bar</span><span class="sub">klh-local services</span>
  <span class="right"><i class="dot blink" id="live"></i><span id="clockbox">—</span></span></header>
<h2>Caddy</h2>
<div id="caddyline">—</div>
<div id="registryline"></div>
<h2>Services</h2>
<div class="scroll"><table id="services"></table></div>
<footer><a href="http://www.threads.dk">a Threads thing</a>
  <span class="right">bar.local · refresh 3s</span></footer>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function hhmmss(ts){
  var d=new Date(ts),p=function(n){return (n<10?'0':'')+n;};
  return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
function tick(){
  fetch('/api/status').then(function(r){return r.json();}).then(function(s){
    clockbox.textContent=hhmmss(s.ts);
    live.className='dot blink';
    caddyline.innerHTML=s.caddy.listening
      ?'<span class="ok">listening</span> on :80 <span class="mut">· '+esc(s.caddy.version||'caddy')+'</span>'
      :'<span class="bad">silent</span> on :80 <span class="mut">· sites served straight from their ports until caddy returns</span>';
    registryline.textContent=s.registry;
    if(s.error){registryline.innerHTML='<span class="bad">'+esc(s.error)+'</span>';return;}
    services.innerHTML='<tr><th>service</th><th>port</th><th>target</th><th>health</th>'
      +'<th>dns claim</th><th>fragment</th><th class="r">created</th></tr>'
      +(s.services.length?s.services.map(function(x){
        var health=x.health.ok
          ?'<span class="ok">'+esc(x.health.code)+' · '+x.health.ms+'ms</span>'
          :'<span class="bad">down · '+x.health.ms+'ms</span>';
        var dns=!x.dns.claimed
          ?'<span class="mut">—</span>'
          :(x.dns.alive
            ?'<span class="ok">alive</span> <span class="mut">pid '+x.dns.pid+'</span>'
            :'<span class="bad">dead</span> <span class="mut">pid '+x.dns.pid+'</span>');
        var frag=x.fragment
          ?'<span title="'+esc(x.fragment)+'">present</span>'
          :'<span class="bad">missing</span>';
        return '<tr><td>'+esc(x.name)+'</td><td>:'+x.port+'</td><td class="mut">'+esc(x.target)
          +'</td><td>'+health+'</td><td>'+dns+'</td><td>'+frag+'</td><td class="r mut">'+esc((x.created_at||'').slice(0,10))+'</td></tr>';
      }).join(''):'<tr><td colspan="7" class="empty">no services registered — <span class="mut">klh-local register &lt;name&gt; --port N</span></td></tr>');
  }).catch(function(){
    clockbox.textContent='—';
    live.className='dot';
  });
}
tick();setInterval(tick,3000);
</script>
</body></html>`;

// ─── llms.txt — the plain-text intro ───
const LLMS = `# klh-local

One command per local service on macOS. \`klh-local register <name> --port N\`
writes a Caddy site fragment, claims <name>.local over mDNS (dns-sd), records
the service in a registry file, and reloads Caddy — a user-level LaunchAgent,
zero sudo, zero downtime. The catch-all Caddy block aborts every Host no
fragment claims: default-deny for anything unregistered.

## Verbs

  install                caddy (brew, if missing) + Caddyfile + user LaunchAgent
  register <name> --port N [--health /p] [--no-dns]
  deregister <name>      remove fragment, kill dns claim, forget
  list                   registry table
  status                 health + dns + fragment per service (read-only)
  reload                 caddy validate + reload
  hosts-apply            rewrite the managed /etc/hosts block (sudo)

## Registry

~/.local/state/klh-local/registry.json — one JSON array: name, port,
health_path, dns claim (pid), caddy fragment path, created_at.

This page is the bar: the registry rendered live on :${PORT}, fronted by Caddy
at http://bar.local/. GET /api/status is the same snapshot as JSON.

https://github.com/klh/local

a Threads thing — http://www.threads.dk
`;

// ─── server ───
const json = (x: unknown): Response =>
	new Response(JSON.stringify(x, null, 2), {
		headers: { "content-type": "application/json" },
	});

Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",
	async fetch(req): Promise<Response> {
		const path = new URL(req.url).pathname;
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
	`klh-local bar → http://127.0.0.1:${PORT} · LAN: http://bar.local:${PORT} (via caddy: http://bar.local/)`,
);
