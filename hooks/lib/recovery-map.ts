// hooks/lib/recovery-map.ts — W273: the recovery map. DATA, not branches:
// one keyed entry per monitored fleet service → how the board probes it,
// a plain-language "what happened", likely causes and exact, copyable
// recovery commands. The board renders it on every DOWN/degraded row so a
// user knows how to recover without reading the repo.
//
// Placeholder law: commands NEVER carry secrets, real hostnames or a
// machine's absolute home path — loopback, `~`, `$(id -u)` and env-named
// checkouts only. test/recovery-map.test.ts pins that, and pins that every
// probed service has an entry.
import { readFileSync } from "node:fs";

export type ProbeSpec =
	| { kind: "http"; port: number; path: string }
	| { kind: "launchd"; label: string };

export interface RecoveryStep {
	label: string;
	cmd: string;
}

export interface RecoveryEntry {
	id: string;
	name: string;
	probe: ProbeSpec;
	// one line, plain language: what the user is looking at when it's dark
	what: string;
	causes: string[];
	recovery: RecoveryStep[];
}

const kick = (label: string): RecoveryStep => ({
	label: `restart the launchd agent (${label})`,
	cmd: `launchctl kickstart -k gui/$(id -u)/${label}`,
});

const bootstrap = (label: string): RecoveryStep => ({
	label: "agent not loaded? load it, then kickstart",
	cmd: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`,
});

const holder = (port: number): RecoveryStep => ({
	label: `who holds :${port}? (empty = nothing listening)`,
	cmd: `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
});

const killOrphan = (port: number): RecoveryStep => ({
	label: `kill an orphaned listener on :${port} (then restart below)`,
	cmd: `kill $(lsof -tiTCP:${port} -sTCP:LISTEN)`,
});

const tail = (log: string): RecoveryStep => ({
	label: "read the last log lines",
	cmd: `tail -n 50 ${log}`,
});

const curl = (port: number, path: string): RecoveryStep => ({
	label: "re-check by hand",
	cmd: `curl -sS -m 3 -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${port}${path}`,
});

const LOCAL_LLM = "com.suspenders.local-llm";
const SWARM_LOG = "~/.claude-insights/swarm-serve-launchd.log";

const swarm = (port: number): RecoveryEntry => ({
	id: `swarm-${port}`,
	name: `local LLM swarm :${port}`,
	probe: { kind: "http", port, path: "/v1/models" },
	what: `The local model server on :${port} is not answering, so lanes and advice routed to it fall back or stall.`,
	causes: [
		"the model process crashed or was killed (out of memory is the usual one)",
		`the swarm supervisor (${LOCAL_LLM}) is not running, so nothing revives it`,
		"the model is still loading after a restart — give it a minute",
	],
	recovery: [
		holder(port),
		kick(LOCAL_LLM),
		bootstrap(LOCAL_LLM),
		tail(SWARM_LOG),
		curl(port, "/v1/models"),
	],
});

// W331: hub deployments supply their own services list — the built-in map
// describes the co-hosted machine's fleet and is pure noise elsewhere (a NAS
// hub rendering eight false DOWNs for services that are loopback-only on
// another host, plus a launchctl probe no container can run). Env override:
// SUSPENDERS_SERVICES_JSON → file of minimal rows {id,name,probe:{port,path}};
// http probes only, recovery steps derived from the probe. Absent/unreadable
// file → built-in map (host installs).
export const servicesFromJson = (path: string): RecoveryEntry[] | null => {
	try {
		const doc = JSON.parse(readFileSync(path, "utf8")) as {
			id?: string;
			name?: string;
			probe?: { port?: number; path?: string };
		}[];
		if (!Array.isArray(doc)) return null;
		const rows = doc.filter(
			(s) =>
				typeof s?.id === "string" &&
				typeof s?.name === "string" &&
				typeof s?.probe?.port === "number",
		);
		if (rows.length === 0) return null;
		return rows.map((s) => {
			const id = String(s.id);
			const name = String(s.name);
			const port = Number(s.probe?.port);
			const p = typeof s.probe?.path === "string" ? s.probe.path : "/status";
			return {
				id,
				name,
				probe: { kind: "http" as const, port, path: p },
				what: `${name} is not answering — anything routed to it fails.`,
				causes: [
					"the process is down or still starting",
					`something else holds :${port}`,
				],
				recovery: [
					holder(port),
					tail(`~/.claude-insights/${id}.log`),
					curl(port, p),
				],
			};
		});
	} catch {
		return null;
	}
};

const ENTRIES: RecoveryEntry[] = (process.env.SUSPENDERS_SERVICES_JSON
	? servicesFromJson(process.env.SUSPENDERS_SERVICES_JSON)
	: null) ?? [
	{
		id: "belt-gateway-4000",
		name: "belt gateway :4000 (Anthropic shim)",
		probe: { kind: "http", port: 4000, path: "/health/liveliness" },
		what: "The :4000 Anthropic-API shim is dark, so claude CLI lanes pointed at the local fleet cannot reach a model.",
		causes: [
			"an orphaned process still holds :4000 but no longer answers (seen 2026-10-03)",
			`the swarm supervisor (${LOCAL_LLM}) that revives the shim is not running`,
			"the shim crashed on start — the log says why",
		],
		recovery: [
			holder(4000),
			killOrphan(4000),
			kick(LOCAL_LLM),
			bootstrap(LOCAL_LLM),
			tail(SWARM_LOG),
			curl(4000, "/health/liveliness"),
		],
	},
	{
		id: "litellm-4100",
		name: "litellm engine :4100",
		probe: { kind: "http", port: 4100, path: "/health/liveliness" },
		what: "The litellm engine on :4100 is not answering, so routed model calls fail.",
		causes: [
			// W277: litellm joined the swarm supervisor's respawn/circuit-breaker
			// set; the old standalone com.belt.gateway restarter was retired
			// (it was a second :4100 restarter — a fork-bomb hazard).
			`the swarm supervisor (${LOCAL_LLM}) that revives litellm is not running`,
			"an orphaned litellm still holds :4100",
			"litellm failed to start (bad generated config or missing key file) — the log says which",
		],
		recovery: [
			holder(4100),
			killOrphan(4100),
			kick(LOCAL_LLM),
			bootstrap(LOCAL_LLM),
			tail("~/.claude/local-llm/litellm-gateway.log"),
			curl(4100, "/health/liveliness"),
		],
	},
	{
		id: "buckle-4101",
		name: "buckle :4101",
		probe: { kind: "http", port: 4101, path: "/status" },
		what: "The buckle router is not answering, so its routing view and metering on this board are blank.",
		causes: [
			"buckle is not started (it has no launchd agent — it runs from its checkout)",
			"an orphaned buckle process still holds :4101",
			"buckle crashed on a bad upstreams.yaml or policy edit",
		],
		recovery: [
			holder(4101),
			killOrphan(4101),
			{
				label: "start buckle from its checkout (BUCKLE_REPO = your clone)",
				cmd: 'cd "$BUCKLE_REPO" && bun run start',
			},
			curl(4101, "/status"),
		],
	},
	swarm(8901),
	swarm(8902),
	swarm(8903),
	{
		id: "kev-8912",
		name: "kev :8912",
		probe: { kind: "http", port: 8912, path: "/" },
		what: "The kev model server is not answering, so anything routed to kev fails.",
		causes: [
			"the kev launchd agent (com.klh.kev) exited or is not loaded",
			"the model is still downloading or loading after a restart",
			"an orphaned kev process still holds :8912",
		],
		recovery: [
			holder(8912),
			killOrphan(8912),
			kick("com.klh.kev"),
			bootstrap("com.klh.kev"),
			tail("~/.claude-insights/kev.log"),
			curl(8912, "/"),
		],
	},
	{
		id: "suspenders-board",
		name: "suspenders board :7799",
		probe: { kind: "http", port: 7799, path: "/status" },
		what: "The fleet board's launchd instance is not answering on :7799 — this page may be a test or dev instance.",
		causes: [
			"the board agent (com.suspenders.board) exited or is not loaded",
			"another process holds :7799",
		],
		recovery: [
			holder(7799),
			kick("com.suspenders.board"),
			bootstrap("com.suspenders.board"),
			tail("/tmp/fleet-board.log"),
			curl(7799, "/status"),
		],
	},
	{
		id: "caddy",
		name: "Caddy (.local services)",
		probe: { kind: "http", port: 2019, path: "/config/" },
		what: "Caddy is down, so every http://<name>.local/ address stops resolving to its service (direct ports still work).",
		causes: [
			"the Caddy agent (com.klh-local.caddy) exited or is not loaded",
			"a Caddyfile edit does not parse — Caddy refuses to start",
		],
		recovery: [
			kick("com.klh-local.caddy"),
			bootstrap("com.klh-local.caddy"),
			{
				label: "validate the Caddyfile",
				cmd: "caddy validate --config ~/.local/state/klh-local/Caddyfile",
			},
			tail("~/.local/state/klh-local/caddy.log"),
			curl(2019, "/config/"),
		],
	},
	{
		id: "launchd-local-llm",
		name: `launchd ${LOCAL_LLM}`,
		probe: { kind: "launchd", label: LOCAL_LLM },
		what: "The swarm supervisor is not running, so a crashed local model or the :4000 shim stays dead instead of being revived.",
		causes: [
			"the agent was unloaded (bootout) or never installed",
			"bun or the swarm script moved, so launchd cannot exec it",
		],
		recovery: [
			kick(LOCAL_LLM),
			bootstrap(LOCAL_LLM),
			{
				label: "inspect the agent's state and last exit",
				cmd: `launchctl print gui/$(id -u)/${LOCAL_LLM}`,
			},
			tail(SWARM_LOG),
		],
	},
	// W277 retired the standalone com.belt.gateway launchd agent (it was a
	// second :4100 restarter racing the swarm supervisor — a fork-bomb
	// hazard); litellm now lives solely under launchd-local-llm's
	// respawn/circuit-breaker set, so there is no longer a separate
	// launchd entry to probe here.
];

export const RECOVERY_MAP: Readonly<Record<string, RecoveryEntry>> =
	Object.freeze(Object.fromEntries(ENTRIES.map((e) => [e.id, e])));

// the services the board probes, in display order — every id MUST have a
// recovery entry (pinned by test)
export const PROBED_SERVICES: readonly string[] = Object.freeze(
	ENTRIES.map((e) => e.id),
);

export const recoveryFor = (id: string): RecoveryEntry | null =>
	Object.hasOwn(RECOVERY_MAP, id) ? RECOVERY_MAP[id] : null;

// placeholder law, as code: anything that looks like a credential, a real
// host or a machine-specific absolute path. Loopback + .local placeholders
// pass; `~` and env-named paths pass.
const LEAKS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{8,}/,
	/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{8,}/,
	/\bBearer\s+\S+/i,
	/(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/i,
	/\/Users\/[^/\s]+/,
	/\/home\/[^/\s]+/,
	/\/Volumes\//,
	/\b(?!127\.0\.0\.1\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
	/https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/]|<name>\.local\/)[^\s'"]+/i,
];

export const leaksIn = (text: string): string[] =>
	LEAKS.filter((re) => re.test(text)).map((re) => re.source);
