// settings.env-map.ts — THE one table from legacy env knobs to settings
// paths. During the transition an explicitly-set mapped env var still wins
// over settings.json (precedence: defaults < file < env), and the reader
// logs it ONCE per process as deprecated, naming the path to set instead.
// Secrets are never mapped (they stay env NAMES / 0600 file PATHS), and
// process plumbing (HOME, PATH, identity, test seams) is allowlisted below
// so the ratchet guard counts only real knobs.

export type EnvKind = "int" | "num" | "bool" | "str" | "csv";

export interface EnvMapping {
	env: string;
	path: string;
	kind: EnvKind;
	/** str values rewritten before validation ("0" → "off" etc.). */
	alias?: Record<string, string>;
}

const m = (
	env: string,
	path: string,
	kind: EnvKind,
	alias?: Record<string, string>,
): EnvMapping => (alias ? { env, path, kind, alias } : { env, path, kind });

export const ENV_MAP: readonly EnvMapping[] = [
	// gates
	m("SUSPENDERS_MAX_READ", "gates.max_read_bytes", "int"),
	m("SUSPENDERS_REREAD_NUDGE", "gates.reread_nudge", "bool"),
	m("SUSPENDERS_MAX_MUTATION", "gates.max_mutation_lines", "int"),
	m("SUSPENDERS_COORD_EDIT_GATE", "gates.coordinator_edit_gate", "bool"),
	m("SUSPENDERS_SCRUB", "gates.scrub", "bool"),
	m("SUSPENDERS_SCRUB_DENYLIST", "gates.scrub_denylist", "str"),
	m("SUSPENDERS_PATCH_FIRST", "gates.patch_first", "bool"),
	m("SUSPENDERS_IMPORT_LAW", "gates.import_law", "bool"),
	m("SUSPENDERS_DONE_DOCS", "gates.done_docs", "bool"),
	m("SUSPENDERS_TRAILER_GATE", "gates.trailer_gate", "str", { "0": "off" }),
	m("SUSPENDERS_ADVISORY_COOLDOWN_MS", "gates.advisory_cooldown_ms", "int"),
	m("SUSPENDERS_NUDGE_COOLDOWN_MS", "gates.nudge_cooldown_ms", "int"),
	m("SUSPENDERS_CONTEXT_GUARD_PCT", "gates.context_guard_pct", "int"),
	m("SUSPENDERS_CONTEXT_CRITICAL_PCT", "gates.context_critical_pct", "int"),
	m("SUSPENDERS_GATE_DAEMON", "gates.daemon", "bool"),
	// steer / consult
	m("SUSPENDERS_STEER_MIN_INTERVAL_S", "steer.min_interval_s", "int"),
	m("SUSPENDERS_CONSULT_SPAWN_TIMEOUT_MS", "consult.spawn_timeout_ms", "int"),
	m("SUSPENDERS_CONSULT_MAX_CONCURRENT", "consult.max_concurrent", "int"),
	m("SUSPENDERS_CONSULT_FEDERATION_FILE", "consult.federation_file", "str"),
	// knowledge
	m("SUSPENDERS_KEV_URL", "knowledge.kev_url", "str"),
	m("SUSPENDERS_KNOWLEDGE_SINK_URL", "knowledge.sink.url", "str"),
	m("SUSPENDERS_KNOWLEDGE_KEY_FILE", "knowledge.sink.key_file", "str"),
	m("SUSPENDERS_KNOWLEDGE_SINK_TIMEOUT_MS", "knowledge.sink.timeout_ms", "int"),
	// board
	m("SUSPENDERS_BOARD_POLL_MEMO_MS", "board.poll_memo_ms", "int"),
	m("SUSPENDERS_BOARD_SYNC_FLOOR_MS", "board.sync_floor_ms", "int"),
	m("SUSPENDERS_BOARD_SYNC_IDLE_MS", "board.sync_idle_ms", "int"),
	m("SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS", "board.front_timeout_ms", "int"),
	m("SUSPENDERS_REPORT_STALL_MS", "board.report_stall_ms", "int"),
	m("SUSPENDERS_MDNS", "board.mdns", "bool"),
	// fleet loop / dispatch
	m("SUSPENDERS_MAINTENANCE", "fleet_loop.maintenance", "bool"),
	m("SUSPENDERS_MERGE_STUCK_HOURS", "fleet_loop.merge_stuck_hours", "int"),
	m("SUSPENDERS_LANE_EFFORT", "dispatch.lane_effort", "str"),
	m("SUSPENDERS_LANE_MAX_ATTEMPTS", "dispatch.lane_max_attempts", "int"),
	m("SUSPENDERS_LANE_DEADLINE_MS", "dispatch.lane_deadline_ms", "int"),
	m("SUSPENDERS_LANE_KEY_TIMEOUT_MS", "dispatch.lane_key_timeout_ms", "int"),
	m("SUSPENDERS_PLAID_PRESSURE_HOLD", "dispatch.plaid_pressure_hold", "bool"),
	m("SUSPENDERS_COORD_MAX_PEERS", "dispatch.coord_max_peers", "int"),
	m("SUSPENDERS_COORD_RATE_WINDOW_MS", "dispatch.coord_rate_window_ms", "int"),
	m("SUSPENDERS_COORD_RATE_MAX", "dispatch.coord_rate_max", "int"),
	// buckle
	m("BUCKLE_MAX_INFLIGHT", "buckle.max_inflight", "int"),
	m("BUCKLE_RETRY_AFTER_S", "buckle.retry_after_s", "int"),
	m("BUCKLE_RETRY_AFTER_MAX_S", "buckle.retry_after_max_s", "int"),
	m("BUCKLE_SLOT_LEASE_MS", "buckle.slot_lease_ms", "int"),
	m("BUCKLE_AFFINITY", "buckle.affinity", "bool"),
	m("BUCKLE_AFFINITY_TTL_S", "buckle.affinity_ttl_s", "int"),
	m("BUCKLE_REPO_TIER_POLICY", "paths.repo_tier_policy", "str"),
	m("BUCKLE_UPSTREAMS", "paths.upstreams", "str"),
	m("BELT_POLICY", "paths.routing_policy", "str"),
	// paths / telemetry
	m("SUSPENDERS_PREFIX", "paths.suspenders_prefix", "str"),
	m("SUSPENDERS_SHIM_BIN", "paths.shim_bin", "str"),
	m("SUSPENDERS_DROP_DIR", "paths.drop_dir", "str"),
	m("LOCAL_LLM_HOME", "paths.local_llm_home", "str"),
	m("LOG_LEVEL", "telemetry.log_level", "str"),
	m("SUSPENDERS_NO_HYPERLINK", "telemetry.no_hyperlink", "bool"),
	m("SUSPENDERS_REPORT_LINK_BASE", "telemetry.report_link_base", "str"),
	m("SUSPENDERS_SELF_HUB_LABEL", "telemetry.self_hub_label", "str"),
	m("KLH_CACHE_TELEMETRY", "telemetry.cache_telemetry", "bool"),
];

export const ENV_BY_NAME: ReadonlyMap<string, EnvMapping> = new Map(
	ENV_MAP.map((e) => [e.env, e]),
);
export const ENV_BY_PATH: ReadonlyMap<string, EnvMapping> = new Map(
	ENV_MAP.map((e) => [e.path, e]),
);

/** Secret-shaped names: never settings — they stay env NAMES / 0600 files. */
export const SECRET_ENV = /(?:TOKEN|_KEY|SECRET|PASSWORD|_PAT)(?:_FILE|_ENV)?$/;

/** Process plumbing + identity + test seams: not knobs, never mapped. */
export const PLUMBING_ENV: ReadonlySet<string> = new Set([
	"HOME",
	"PATH",
	"TMPDIR",
	"TERM",
	"NO_COLOR",
	"USER",
	"SHELL",
	"PWD",
	"LANG",
	"TZ",
	"CI",
	"NODE_ENV",
	"KLH_SETTINGS",
	"KLH_STACK",
	"SUSPENDERS_HUBS_FILE",
	"SUSPENDERS_SID",
	"SUSPENDERS_HOME",
	"GOVERNOR_STORE_URL",
	"KLH_SESSION_ROLE",
	"SUSPENDERS_REPO",
]);

const TRUE = new Set(["1", "true", "on", "yes"]);
const FALSE = new Set(["0", "false", "off", "no"]);

/** Coerce a raw env string for its mapping; undefined = unparseable. */
export function coerceEnv(map: EnvMapping, raw: string): unknown {
	const t = raw.trim();
	if (t === "") return undefined;
	switch (map.kind) {
		case "int": {
			const n = Number(t);
			return Number.isInteger(n) ? n : undefined;
		}
		case "num": {
			const n = Number(t);
			return Number.isFinite(n) ? n : undefined;
		}
		case "bool": {
			const l = t.toLowerCase();
			if (TRUE.has(l)) return true;
			if (FALSE.has(l)) return false;
			return undefined;
		}
		case "csv":
			return t
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		default:
			return map.alias?.[t] ?? t;
	}
}
