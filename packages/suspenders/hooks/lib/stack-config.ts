// hooks/lib/stack-config.ts — the ONE stack config reader (config-over-code:
// real hosts, ports, secret PATHS live only in ~/.config/klh/stack.json,
// mode 600; the legacy stack.yaml name is honored read-only until the
// install migrate step runs — W1253 Amendment A: fleet config is JSON).
// deploy/hubctl.ts renders deploys from it; coord hubs (W356) projects the
// topology from it. KLH_STACK overrides the path (tests).
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { GatewayPolicy } from "../../../buckle/src/policy.ts";
import { readJsonConfEither } from "./kernel-conf.ts";

// ─── W1303.4 schema-first: zod is THE definition of the stack conf shape ──
// JSON.parse stays the ONE parser (W1253 Amendment A); these schemas type
// the parsed value and validate it AFTER parse (stackConfIssues — strict
// reporting without changing loadStack's behavior for any accepted conf).

/** One provider key declaration (env NAME / 0600 key_file / inline). */
export const ProviderEntrySchema = z
	.object({
		env: z.string().optional(),
		key_file: z.string().optional(),
		key_name: z.string().optional(),
		key: z.string().optional(),
		base_url: z.string().optional(),
	})
	.loose();

/** One executor row: per-executor gateway base(s) + model pin. */
export const ExecutorConfigSchema = z
	.object({
		anthropic_base: z.string().optional(),
		openai_base: z.string().optional(),
		model: z.string().optional(),
	})
	.loose();

/** Per-repo routing policy (must/prefer law expressions, hub, residency). */
export const RepoPolicySchema = z
	.object({
		must: z.string().optional(),
		prefer: z.string().optional(),
		hub: z.string().optional(),
		residency: z.array(z.string()).optional(),
	})
	.loose();

/** Auth posture section (scoped tokens + Entra/OIDC placeholders). */
export const StackAuthSchema = z
	.object({
		required: z.boolean().optional(),
		tokens: z.object({ ttlHours: z.number().optional() }).loose().optional(),
		oidc: z
			.object({
				enforced: z.boolean().optional(),
				issuer: z.string().optional(),
				jwksUri: z.string().optional(),
				audience: z.string().optional(),
				requiredScope: z.string().optional(),
			})
			.loose()
			.optional(),
	})
	.loose();

/** Deploy source: git ref pins + origin overrides (never host paths). */
export const HubReposSchema = z
	.object({
		ref: z.string().optional(),
		buckle: z.string().optional(),
		suspenders: z.string().optional(),
		belt: z.string().optional(),
		src: z.string().optional(),
	})
	.loose();

/** Deploy target on the hub device — dir REQUIRED when present. */
export const HubDeploySchema = z
	.object({
		ssh: z.string().optional(),
		dir: z.string(),
		docker: z.string().optional(),
		compose: z.string().optional(),
		connect_timeout: z.number().optional(),
	})
	.loose();

/** W1097: the managed ssh tunnel front for hub trace receipts. */
export const TraceTunnelSchema = z
	.object({
		listen_port: z.number(),
		target_port: z.number().optional(),
		read_key: z.string(),
	})
	.loose();

/** THE hub profile — every knob the deploy + topology readers consume.
 *  Loose: forward-compat sections ride; named fields are the contract. */
export const HubProfileSchema = z
	.object({
		host: z.string(),
		/** Human-facing hub label; the profile key stays the routing identity. */
		display_name: z.string().optional(),
		/** Browser-facing console; never inferred from the Buckle probe URL. */
		console_url: z.string().optional(),
		/** Reviewed canary ref for this hub only (W1094.1 posture) — other
		 *  hubs keep the shared stack version pinned. */
		version_override: z.string().optional(),
		/** W1094.1: hub-machine terminal endpoints (model engines etc.) the
		 *  route preflight gate may treat as leaves ON THIS hub — never
		 *  inherited from the Mac specialist registry. */
		route_preflight: z
			.object({ terminal_origins: z.array(z.string()).optional() })
			.loose()
			.optional(),
		buckle_port: z.number().optional(),
		board_port: z.number().optional(),
		store_port: z.number().optional(),
		belt_port: z.number().optional(),
		/** Optional Belt-owned OpenAI model wire (local model server URL from
		 *  machine config, never a model name compiled into Fleet). */
		belt_model: z
			.object({
				port: z.number(),
				health_port: z.number(),
				upstream: z.string(),
			})
			.loose()
			.optional(),
		/** Health sidecar serve ports (W422.10) — where each *-health probe
		 *  serves its verdict; falls through to the template default. */
		buckle_health_port: z.number().optional(),
		board_health_port: z.number().optional(),
		store_health_port: z.number().optional(),
		belt_health_port: z.number().optional(),
		/** W763 hub model store — the face port + its health sidecar. */
		model_store_port: z.number().optional(),
		model_store_health_port: z.number().optional(),
		/** W1217: the hub knowledge sink (aggregated claim store; declaring it
		 *  enables the `knowledge` compose profile — sink + health probe). */
		knowledge: z
			.object({
				port: z.number().optional(),
				health_port: z.number().optional(),
			})
			.loose()
			.optional(),
		/** W467 synthetic readiness: the buckle-ready sidecar's completion-leg
		 *  verdict port; ready_model must be one the ladder serves. */
		buckle_ready_port: z.number().optional(),
		ready_model: z.string().optional(),
		/** W688.7.1: the buckle entrypoint the hub runs (unset = solo posture
		 *  src/server.ts; an enterprise hub points at the overlay entry). */
		buckle_entry: z.string().optional(),
		/** W688.7.1: private-network hosts the ladder may reach over plain
		 *  http (BUCKLE_HTTP_UPSTREAM_HOSTS egress allowlist). */
		http_upstream_hosts: z.array(z.string()).optional(),
		/** W688.3: overlay code-loader knobs (KLH_OVERLAY_* env) — dir = the
		 *  overlay dir INSIDE the container, sha256 pins the entry digest,
		 *  allow adds operator allow-roots (e.g. /src/fleet/packages). */
		overlay: z
			.object({
				dir: z.string().optional(),
				sha256: z.string().optional(),
				allow: z.string().optional(),
			})
			.loose()
			.optional(),
		/** W854: the mDNS announcer (deploy/mdns/announce.ts) — what the hub
		 *  advertises as _klh-hub._tcp. All knobs optional; undeclared = the
		 *  compose template defaults (addr auto-detect, hostname = normalized
		 *  label, health 4114, sidecar 4115). */
		mdns: z
			.object({
				port: z.number().optional(),
				addr: z.string().optional(),
				hostname: z.string().optional(),
				interval_ms: z.number().optional(),
				health_port: z.number().optional(),
				sidecar_port: z.number().optional(),
			})
			.loose()
			.optional(),
		bind: z.string().optional(),
		board_bind: z.string().optional(),
		belt_bind: z.string().optional(),
		allowed_hosts: z.array(z.string()).optional(),
		services_json: z.string().optional(),
		peers: z.array(z.string()).optional(),
		/** W230: the buckle front URL this hub serves — resolveHub consults it
		 *  (before the hubs.json registry) — plus an optional front token. */
		url: z.string().optional(),
		token: z.string().optional(),
		/** Local 0600 file containing a hub-scoped admin read key. */
		token_file: z.string().optional(),
		/** Deploy source: `ref` pins the git ref; named entries override
		 *  origins (forks/mirrors) — never host paths. `src` = the packages
		 *  root inside the clone (overlay monorepo layout; unset = public). */
		repos: HubReposSchema.optional(),
		/** Deploy target on the hub device; dir is REQUIRED with the section
		 *  (the hub pulls code from git origins into volumes). */
		deploy: HubDeploySchema.optional(),
		/** Display-only provider placement while its credential-gated route
		 *  is being prepared; never enables an upstream or draws a path. */
		provider_intents: z.array(z.string()).optional(),
		/** W1124.8.2.1: central provider profiles this hub REQUIRES (stack
		 *  `providers` map names — the shared resolver lives in
		 *  speedy/src/provider-config.ts). hubctl push resolves each and
		 *  materializes the 0600 provider.env ON the hub (key → profile env
		 *  binding, never printed). Unset/empty = no central delivery — the
		 *  ladder-key path (secrets.upstream_keys) stands unchanged. */
		provider_requirements: z.array(z.string()).optional(),
		/** W483: nightly dark window "HH:MM-HH:MM" (may cross midnight) — the
		 *  hub is EXPECTED down in it (NAS DSM poweroff); routing skips. */
		quiet_hours: z.string().optional(),
		trace_tunnel: TraceTunnelSchema.optional(),
		/** W688.7.1: the hub's REAL upstream ladder (config-over-code) —
		 *  inline groups rows merge over the committed placeholder ladder;
		 *  keys ride env vars named per-row, never values here. */
		upstreams: z
			.object({
				groups: z
					.record(z.string(), z.array(z.record(z.string(), z.unknown())))
					.optional(),
				openrouter_free_catalog_file: z.string().optional(),
				zai_catalog_file: z.string().optional(),
				zai_litellm_url: z.string().optional(),
				zai_concurrency_error_codes: z.array(z.string()).optional(),
			})
			.loose()
			.optional(),
		/** W983: the routing-decision gates (allow_cloud / cost_speed). */
		buckle_prefs: z
			.object({
				allow_cloud: z.boolean().optional(),
				cost_speed: z.enum(["balanced", "cost", "speed", "quality"]).optional(),
			})
			.loose()
			.optional(),
		/** Secret PATHS on the owning device — values never live in config. */
		secrets: z
			.object({
				buckle_root_key: z.string().optional(),
				buckle_service_key: z.string().optional(),
				buckle_service_key_env: z.string().optional(),
				upstream_keys: z.record(z.string(), z.string()).optional(),
			})
			.loose()
			.optional(),
		/** Private native metrics connector (policy data, never credentials). */
		metrics: z
			.object({
				litellm: z.object({
					url: z.string(),
					key_env: z.string(),
					source_id: z.string(),
				}),
			})
			.loose()
			.optional(),
		/** Per-hub Buckle gateway overrides — opaque policy object owned by
		 *  buckle's policy.ts (cross-package type rides loose here). */
		buckle_gateway: z.custom<GatewayPolicy>().optional(),
	})
	.loose();

/** THE stack config (~/.config/klh/stack.json) — every section optional
 *  except hubs; an empty file is a valid empty config (loader contract).
 *  W1253 Amendment A: JSON.parse stays the ONE parser; this schema types
 *  the parsed value (stackConfIssues validates strictly when asked). */
export const StackConfigSchema = z
	.object({
		/** Models without provider prompt-cache reporting; local KV reuse is
		 *  separate. */
		cache_unsupported_models: z.array(z.string()).optional(),
		/** The stack version: ONE string pins buckle+suspenders+belt — the
		 *  ref every repo sidecar pulls. Absent = main (dev posture). */
		version: z.string().optional(),
		hubs: z.record(z.string(), HubProfileSchema),
		/** W372 auth posture (scoped tokens + Entra/OIDC — machine file only). */
		auth: StackAuthSchema.optional(),
		/** W230: providers — where upstream API keys live (env NAME, 0600
		 *  secret file, or inline on the machine file). Values never in repos. */
		providers: z.record(z.string(), ProviderEntrySchema).optional(),
		/** W230: executors — per-executor gateway base(s) + model pin; the
		 *  `default` row is the fallback for any id without its own. */
		executors: z.record(z.string(), ExecutorConfigSchema).optional(),
		/** W230: policies — per-repo routing policy (must/prefer law
		 *  expressions, hub label, residency regions). */
		policies: z.record(z.string(), RepoPolicySchema).optional(),
	})
	.loose();

// W1303.4 schema-first: derived from HubProfileSchema above — never hand-written.
export type HubProfile = z.infer<typeof HubProfileSchema>;

// W1303.4 schema-first: derived from StackConfigSchema above — never hand-written.
export type StackConfig = z.infer<typeof StackConfigSchema>;

export const STACK_PATH = (): string =>
	process.env.KLH_STACK ?? join(homedir(), ".config", "klh", "stack.json");

// ---- W230: providers / executors / policies --------------------------------

// W1303.4 schema-first: derived from ProviderEntrySchema above — never hand-written.
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

// W1303.4 schema-first: derived from ExecutorConfigSchema above — never hand-written.
export type ExecutorConfig = z.infer<typeof ExecutorConfigSchema>;

// W1303.4 schema-first: derived from RepoPolicySchema above — never hand-written.
export type RepoPolicy = z.infer<typeof RepoPolicySchema>;

/** Parse the machine-level stack config — W230: the ONE user-editable
 *  surface (providers/executors/policies join hubs; every section is
 *  optional, an empty file is a valid empty config). JSON only (W1253
 *  Amendment A); the legacy stack.yaml name parses when its content is
 *  already JSON — real yaml needs the install migrate step first. */
export function loadStack(): StackConfig {
	const raw = readJsonConfEither(STACK_PATH()) as StackConfig | null;
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

/** W1303.4 schema-first: strict conf reporting — safeParse the parsed
 *  machine config against StackConfigSchema and render `path: message`
 *  lines. loadStack's behavior is UNCHANGED (any accepted conf still
 *  loads); this is the operator-facing diagnostic + the test surface that
 *  pins the schema to the real file shape. */
export function stackConfIssues(conf: unknown = loadStack()): string[] {
	return (
		StackConfigSchema.safeParse(conf).error?.issues.map(
			(i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
		) ?? []
	);
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
