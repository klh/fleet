// hooks/lib/stack-config.ts — the ONE stack.yaml reader (config-over-code:
// real hosts, ports, secret PATHS live only in ~/.config/klh/stack.yaml,
// mode 600). deploy/hubctl.ts renders deploys from it; coord hubs (W356)
// projects the topology from it. KLH_STACK overrides the path (tests).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "yaml";

export interface HubProfile {
	/** Reviewed canary ref for this hub only. Keeps the shared stack version
	 * pinned for other hubs while one hub validates a new public base. */
	version_override?: string;
	host: string;
	/** Human-facing hub label. The profile key stays the stable routing identity. */
	display_name?: string;
	/** Browser-facing console. Never inferred from the Buckle probe URL. */
	console_url?: string;
	buckle_port?: number;
	board_port?: number;
	store_port?: number;
	belt_port?: number;
	/** Health sidecar serve ports (W422.10) — where each *-health probe
	 *  serves its verdict; falls through to the template default when
	 *  undeclared. */
	buckle_health_port?: number;
	board_health_port?: number;
	store_health_port?: number;
	belt_health_port?: number;
	/** W763 hub model store — the face port + its health sidecar. */
	model_store_port?: number;
	model_store_health_port?: number;
	/** Synthetic readiness (W467): where the buckle-ready sidecar serves the
	 *  completion-leg verdict, and which model the synthetic 1-token request
	 *  names (must be one the hub's routing ladder actually serves). */
	buckle_ready_port?: number;
	ready_model?: string;
	/** W688.7.1: the buckle entrypoint the hub runs (path inside the
	 *  container). Unset = the base `src/server.ts` (provider-less solo
	 *  posture); an enterprise hub points it at the overlay entry that
	 *  injects the gov providers (its own src/server.ts). */
	buckle_entry?: string;
	/** W688.7.1: private-network hosts the ladder may reach over plain http
	 *  (BUCKLE_HTTP_UPSTREAM_HOSTS egress allowlist), e.g. the engine host. */
	http_upstream_hosts?: string[];
	/** W688.3: the overlay code-loader knobs the buckle container receives
	 *  (KLH_OVERLAY_* env, config-over-code). dir = the overlay dir path
	 *  INSIDE the container (the code arrives via the fleet-repo volume on
	 *  an overlay hub); sha256 pins the entry digest (refuse-on-mismatch);
	 *  allow adds operator allow-roots beyond the compiled defaults — on an
	 *  overlay hub that is the pinned checkout root (e.g. /src/fleet/packages).
	 *  Unset = solo posture, unchanged. */
	overlay?: { dir?: string; sha256?: string; allow?: string };
	/** W854: the mDNS announcer (deploy/mdns/announce.ts) — what the hub
	 *  advertises as _klh-hub._tcp and where its health faces live. All
	 *  knobs optional; undeclared = the compose template defaults. port
	 *  defaults to buckle_port; addr undeclared = auto-detect (and an
	 *  undetectable address SKIPS the A record — never advertise 127.0.0.1);
	 *  hostname defaults to the normalized label (the same form hub-locate's
	 *  mdns-guess leg tries); interval_ms = steady re-announce cadence;
	 *  health_port = the announcer's self-report port (4114), sidecar_port
	 *  = the mdns-health probe's verdict port (4115). */
	mdns?: {
		port?: number;
		addr?: string;
		hostname?: string;
		interval_ms?: number;
		health_port?: number;
		sidecar_port?: number;
	};
	bind?: string;
	board_bind?: string;
	belt_bind?: string;
	allowed_hosts?: string[];
	services_json?: string;
	peers?: string[];
	/** W230: the buckle front URL this hub serves — resolveHub consults it
	 *  (before the hubs.json registry) — plus an optional front token. */
	url?: string;
	token?: string;
	/** Local 0600 file containing a hub-scoped admin read key. */
	token_file?: string;
	/** Deploy source: `ref` pins the git ref for all three repos; the named
	 *  entries override origins (forks/mirrors) — never host paths, the hub
	 *  pulls its code from the git origins into volumes. */
	repos?: {
		ref?: string;
		buckle?: string;
		suspenders?: string;
		belt?: string;
		/** Packages root inside the clone the hub services run from. An
		 *  overlay monorepo (private tier) resolves its pinned public base
		 *  under node_modules/<dep>/packages; unset = the public layout. */
		src?: string;
	};
	deploy?: {
		ssh?: string;
		dir: string;
		docker?: string;
		compose?: string;
		/** W701: seconds ssh/scp wait to connect (-o ConnectTimeout) before
		 *  an unreachable hub fails fast; unset = 10. BatchMode is always on. */
		connect_timeout?: number;
	};
	/** W688.7.1: the hub's REAL upstream ladder (config-over-code) — inline
	 *  `groups:` in buckle's upstreams.yaml shape, materialized by hubctl
	 *  into the deploy dir and merged over the committed (placeholder)
	 *  ladder via BUCKLE_UPSTREAMS. Keys stay in env vars named by each
	 *  row's api_key_env — never values here. */
	upstreams?: {
		groups?: Record<string, Array<Record<string, unknown>>>;
		/** Machine-local generated OpenRouter free-model snapshot. hubctl
		 * merges this below explicit groups when pushing hub config. */
		openrouter_free_catalog_file?: string;
	};
	/** Display-only provider placement while its credential-gated route is
	 *  being prepared. This never enables a Buckle upstream or draws a path. */
	provider_intents?: string[];
	/** W983: this hub's Buckle owner prefs — the allow_cloud / cost_speed
	 *  switches the routing decision gates every cloud hop behind (decide.ts
	 *  precedence 1). hubctl push materializes them into the 0600
	 *  buckle-prefs.json the container mounts at BUCKLE_PREFS; undeclared =
	 *  the conservative defaults (cloud closed, balanced). */
	buckle_prefs?: {
		allow_cloud?: boolean;
		cost_speed?: "balanced" | "cost" | "speed" | "quality";
	};
	secrets?: {
		buckle_root_key?: string;
		/** Ladder key env NAME → key-file PATH on the hub device. hubctl push
		 *  materializes them into the 0600 `upstream.env` ON the hub (the
		 *  value is read there, never printed or transported); values never
		 *  live in config. */
		upstream_keys?: Record<string, string>;
	};
	/** W483: nightly dark window "HH:MM-HH:MM" (may cross midnight) — the
	 *  hub is EXPECTED down in it (NAS DSM poweroff). Routing skips, dispatch
	 *  falls back to local belt, monitoring suppresses instead of paging. */
	quiet_hours?: string;
}

export interface StackConfig {
	/** Models without provider prompt-cache reporting; local KV reuse is separate. */
	cache_unsupported_models?: string[];
	/** The stack version: ONE string pins buckle+suspenders+belt — the ref
	 *  every repo sidecar pulls. Absent = main (dev posture). */
	version?: string;
	hubs: Record<string, HubProfile>;
	auth?: {
		required?: boolean;
		/** W372: scoped-token posture (W231) — issuance TTL in hours. */
		tokens?: { ttlHours?: number };
		/** W372: Entra/OIDC posture — full-URL issuer + audience; Entra
		 *  values live ONLY in the machine stack.yaml (placeholders in the
		 *  committed example). `jwksUri` overrides the Entra v2.0 derivation
		 *  for non-Entra IdPs. */
		oidc?: {
			enforced?: boolean;
			issuer?: string;
			jwksUri?: string;
			audience?: string;
			requiredScope?: string;
		};
	};
	/** W230: providers — where upstream API keys live (inline on the
	 *  machine file, an env var NAME, or a 0600 secret file). Values never
	 *  live in repos; the committed template carries placeholders only. */
	providers?: Record<string, ProviderEntry>;
	/** W230: executors — per-executor gateway base(s) + model pin. The
	 *  insertion engine (scripts/lib/insertion.ts, buckle onboard +
	 *  lane-wrap) consumes these; env and CLI flags stay the override
	 *  layer. The `default` row is the fallback for any id without its own. */
	executors?: Record<string, ExecutorConfig>;
	/** W230: policies — per-repo routing policy (must/prefer law
	 *  expressions, hub label, residency regions). */
	policies?: Record<string, RepoPolicy>;
}

export const STACK_PATH = (): string =>
	process.env.KLH_STACK ?? join(homedir(), ".config", "klh", "stack.yaml");

// ---- W230: providers / executors / policies --------------------------------

/** One provider key declaration — the user-facing surface for where an
 *  upstream API key lives. Values never live in repos; the machine file
 *  itself is mode 600. */
export interface ProviderEntry {
	/** env var NAME the key rides at runtime. */
	env?: string;
	/** 0600 dotenv-style file (KEY=VALUE lines); machine-local values. */
	key_file?: string;
	/** var to read from key_file (default: <PROVIDER>_API_KEY). */
	key_name?: string;
	/** inline value — machine file only; never commit real values. */
	key?: string;
	/** provider-native base URL override (custom gateways). */
	base_url?: string;
}

/** One executor row: per-executor gateway base(s) + model pin. */
export interface ExecutorConfig {
	anthropic_base?: string;
	openai_base?: string;
	/** model pin for this executor — routed by id behind belt. */
	model?: string;
}

/** Per-repo routing policy — the machine-level home for what a repo's
 *  .prefer dotfile expresses (dotfiles still win). */
export interface RepoPolicy {
	/** W96 law expression (belt router vocabulary) — hard law. */
	must?: string;
	/** W96 law expression — soft law; must beats prefer. */
	prefer?: string;
	/** default hub label for dispatch from this repo. */
	hub?: string;
	/** allowed regions (buckle gov residency vocabulary). */
	residency?: string[];
}

/** Parse the machine-level stack config — W230: the ONE user-editable
 *  surface (providers/executors/policies join hubs; every section is
 *  optional, an empty file is a valid empty config). */
export function loadStack(): StackConfig {
	const raw = parse(readFileSync(STACK_PATH(), "utf8")) as StackConfig | null;
	return { ...(raw ?? {}), hubs: raw?.hubs ?? {} };
}

/** loadStack() with every failure (missing file, malformed YAML) → null —
 *  the tier every optional-section helper reads through. */
export function tryLoadStack(): StackConfig | null {
	try {
		return loadStack();
	} catch {
		return null;
	}
}

/** W230 executors: the row for `id`, falling through to the `default` row
 *  when the id has none of its own. `id` omitted = the default row. */
export function executorConfig(
	id?: string,
	stack?: StackConfig | null,
): ExecutorConfig | undefined {
	const ex = (stack === undefined ? tryLoadStack() : stack)?.executors;
	if (!ex) return undefined;
	return id ? (ex[id] ?? ex.default) : ex.default;
}

/** W230 policies: the per-repo row — exact basename match first (case-
 *  insensitive), then the `"*"` wildcard row; nothing → undefined. */
export function policyForRepo(
	repo: string,
	stack?: StackConfig | null,
): RepoPolicy | undefined {
	const pol = (stack === undefined ? tryLoadStack() : stack)?.policies;
	if (!pol) return undefined;
	const base = basename(repo).toLowerCase();
	for (const [key, row] of Object.entries(pol)) {
		if (key.toLowerCase() === base) return row;
	}
	return pol["*"];
}

const unquote = (v: string): string => {
	const t = v.trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	) {
		return t.slice(1, -1);
	}
	return t;
};

/** W230 providers: resolve a provider's key — inline `key` → env var named
 *  by `env` → `key_file` (dotenv-style, mode-600 enforced, 1 MiB cap),
 *  variable `key_name ?? <PROVIDER>_API_KEY`. Nothing resolvable → null. */
export function providerKey(
	name: string,
	stack?: StackConfig | null,
): string | null {
	const entry = (stack === undefined ? tryLoadStack() : stack)?.providers?.[
		name
	];
	if (!entry) return null;
	if (entry.key) return entry.key;
	if (entry.env) {
		const v = process.env[entry.env];
		if (v) return v;
	}
	if (entry.key_file) {
		const raw = entry.key_file;
		const path =
			raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
		const st = statSync(path);
		if ((st.mode & 0o777) !== 0o600) {
			throw new Error(
				`provider ${name}: key_file ${raw} must be mode 600 (got ${(st.mode & 0o777).toString(8)})`,
			);
		}
		if (st.size > 1024 * 1024) {
			throw new Error(`provider ${name}: key_file over the 1 MiB cap`);
		}
		const want =
			entry.key_name ??
			`${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
			if (m && m[1] === want) return unquote(m[2]);
		}
	}
	return null;
}

// ---- quiet hours (W483) ----------------------------------------------------
// A hub with `quiet_hours: "00:00-08:00"` is EXPECTED dark in that window
// (NAS DSM nightly poweroff). Consumers: resolveHub (skip dark hubs),
// dispatch-next (fall back to local belt, surfaced), hubctl status (exit 0),
// metrics-alert (suppress instead of paging dead-letter noise).

export interface QuietWindow {
	/** minutes from midnight, inclusive start / exclusive end */
	start: number;
	end: number;
}

/** Parse "HH:MM-HH:MM" — start past end means the window crosses midnight.
 *  Malformed specs return null (a typo never darks a hub by accident). */
export function parseQuietHours(spec: string): QuietWindow | null {
	const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(spec.trim());
	if (!m) return null;
	const [sh, sm, eh, em] = m.slice(1).map(Number);
	const mins = (h: number, mm: number): number | null =>
		h > 23 || mm > 59 ? null : h * 60 + mm;
	const start = mins(sh, sm);
	const end = mins(eh, em);
	if (start === null || end === null || start === end) return null;
	return { start, end };
}

const minutesOf = (d: Date): number => d.getHours() * 60 + d.getMinutes();

/** Is `now` inside the hub's quiet window? No spec (or unparseable) = never
 *  quiet — config-over-code: only an explicit operator window suppresses. */
export function inQuietHours(
	hub: Pick<HubProfile, "quiet_hours">,
	now: Date = new Date(),
): boolean {
	if (!hub.quiet_hours) return false;
	const w = parseQuietHours(hub.quiet_hours);
	if (!w) return false;
	const m = minutesOf(now);
	return w.start < w.end
		? m >= w.start && m < w.end
		: m >= w.start || m < w.end;
}

const profileHost = (hub: HubProfile): string =>
	(hub.host ?? "").replace(/^[^@]+@/, "");

/** Label → is that hub dark RIGHT NOW? Case-insensitive (resolveHub
 *  precedent); missing stack.yaml / unknown label / no window = false. */
export function darkHubNow(label: string, now: Date = new Date()): boolean {
	try {
		const key = label.trim().toLowerCase();
		const hub = Object.entries(loadStack().hubs).find(
			([l]) => l.toLowerCase() === key,
		)?.[1];
		return hub ? inQuietHours(hub, now) : false;
	} catch {
		return false;
	}
}

/** Target URL → is it a quiet-hours hub's host? Metrics-alert suppression
 *  keys on hostname (stack.yaml hosts are bare, ssh user stripped). */
export function urlInQuietHours(url: string, now: Date = new Date()): boolean {
	try {
		const host = new URL(url).hostname;
		return Object.values(loadStack().hubs).some(
			(h) => profileHost(h) === host && inQuietHours(h, now),
		);
	} catch {
		return false;
	}
}
