// settings.knob-registry.ts — W2470.1: EVERY SUSPENDERS_* knob a fleet
// process reads maps to exactly ONE designated home. Homes (W2470 P2):
//   conf         — settings.json row (ENV_MAP-mapped, or pending: the row
//                  lands with the knob's reader migration, P1 pattern)
//   secret       — secret-shaped: env NAME / 0600 file PATH, never settings
//   plumbing     — process plumbing, identity, install handoff, test seams
//   machine-conf — another named machine conf document (stack.json/hubs.json/
//                  belt.env/services.yaml/observation-relays.json)
//   model-plane  — ~/.claude/local-llm model-plane values (URLs, models,
//                  batch/rpm/token knobs)
//   internal     — runtime scratch/state artifacts, never operator-facing
// LAW (W2470): a new SUSPENDERS_* knob MUST add its row here in the same
// landing — tests/knob-registry.guard.e2e.ts scans production .ts for
// SUSPENDERS_* mentions and fails on any knob this registry lacks.
// Derived from settings.env-map.ts + a production-tree scan; regenerate rows
// via the same derivation when ENV_MAP grows (env-map rows win).

export type KnobHomeKind =
	| "conf"
	| "secret"
	| "plumbing"
	| "machine-conf"
	| "model-plane"
	| "internal";

export interface KnobHome {
	env: string;
	kind: KnobHomeKind;
	/** conf: the settings.json path once mapped; machine-conf: the document. */
	detail?: string;
}

const k = (env: string, kind: KnobHomeKind, detail?: string): KnobHome =>
	detail === undefined ? { env, kind } : { env, kind, detail };

export const KNOB_REGISTRY: readonly KnobHome[] = [
	k("SUSPENDERS_ADVISORY_COOLDOWN_MS", "conf", "gates.advisory_cooldown_ms"),
	k("SUSPENDERS_AE_PEER_TOKEN", "secret"),
	k(
		"SUSPENDERS_ALLOWED_HOSTS",
		"machine-conf",
		"stack.json (hub allowed_hosts)",
	),
	k("SUSPENDERS_APPROVALS_DIR", "conf"),
	k("SUSPENDERS_APPROVAL_SECRET", "secret"),
	k("SUSPENDERS_ASK", "conf"),
	k("SUSPENDERS_ASK_DEBUG", "conf"),
	k("SUSPENDERS_BELT_ENV", "machine-conf", "belt.env"),
	k("SUSPENDERS_BELT_READ_ORIGIN", "machine-conf", "stack.json (hub ports)"),
	k("SUSPENDERS_BELT_TOKEN", "secret"),
	k("SUSPENDERS_BELT_URL", "machine-conf", "hubs.json"),
	k("SUSPENDERS_BIND", "machine-conf", "stack.json (hub bind)"),
	k("SUSPENDERS_BIOME_BIN", "conf"),
	k("SUSPENDERS_BOARD_FULL_RECONCILE_MS", "conf"),
	k("SUSPENDERS_BOARD_POLL_MEMO_MS", "conf", "board.poll_memo_ms"),
	k("SUSPENDERS_BOARD_PS_MEMO_MS", "conf"),
	k("SUSPENDERS_BOARD_SESSION_RECENT_MS", "conf"),
	k("SUSPENDERS_BOARD_SYNC_FLOOR_MS", "conf", "board.sync_floor_ms"),
	k("SUSPENDERS_BOARD_SYNC_IDLE_MS", "conf", "board.sync_idle_ms"),
	k("SUSPENDERS_BUCKLE_DB", "machine-conf", "stack.json (hub buckle db path)"),
	k("SUSPENDERS_BUCKLE_FRONT", "machine-conf", "stack.json (hub buckle front)"),
	k("SUSPENDERS_BUCKLE_FRONT_TIMEOUT_MS", "conf", "board.front_timeout_ms"),
	k("SUSPENDERS_BUCKLE_TOKEN", "secret"),
	k("SUSPENDERS_BUCKLE_URL", "machine-conf", "hubs.json"),
	k("SUSPENDERS_CACHE_DRILL_TTL_MS", "conf"),
	k("SUSPENDERS_CACHE_ERA_FIX", "plumbing"),
	k("SUSPENDERS_CACHE_LOCAL", "conf"),
	k("SUSPENDERS_CHATGPT_COORD", "model-plane"),
	k("SUSPENDERS_CKPT_ROOT", "conf"),
	k("SUSPENDERS_CLAUDE_BIN", "conf"),
	k("SUSPENDERS_CLAUDE_CONTROL_TIMEOUT_MS", "conf"),
	k("SUSPENDERS_CLAUDE_NATIVE_BIN", "conf"),
	k("SUSPENDERS_CLAUDE_RESTART_JOURNAL", "internal"),
	k("SUSPENDERS_CLAUDE_WAKE", "conf"),
	k("SUSPENDERS_CLINE_HOOKS_DIR", "internal"),
	k("SUSPENDERS_CLINE_VSCODE_HOOKS_DIR", "internal"),
	k("SUSPENDERS_CODEX_BIN", "conf"),
	k("SUSPENDERS_CODEX_HOOKS", "conf"),
	k("SUSPENDERS_CODEX_NATIVE_BIN", "conf"),
	k("SUSPENDERS_CONNECTIONS_FILE", "machine-conf", "hub connections ledger"),
	k("SUSPENDERS_CONSULT_FEDERATION_FILE", "conf", "consult.federation_file"),
	k("SUSPENDERS_CONSULT_MAX_CONCURRENT", "conf", "consult.max_concurrent"),
	k("SUSPENDERS_CONSULT_SPAWN_TIMEOUT_MS", "conf", "consult.spawn_timeout_ms"),
	k("SUSPENDERS_CONTEXT_CRITICAL_PCT", "conf", "gates.context_critical_pct"),
	k("SUSPENDERS_CONTEXT_GUARD_PCT", "conf", "gates.context_guard_pct"),
	k("SUSPENDERS_COORD_CLI", "conf"),
	k("SUSPENDERS_COORD_CONFIG", "machine-conf", "coordination config file"),
	k("SUSPENDERS_COORD_EDIT_GATE", "conf", "gates.coordinator_edit_gate"),
	k("SUSPENDERS_COORD_MAX_PEERS", "conf", "dispatch.coord_max_peers"),
	k("SUSPENDERS_COORD_MODEL", "model-plane"),
	k("SUSPENDERS_COORD_RATE_MAX", "conf", "dispatch.coord_rate_max"),
	k("SUSPENDERS_COORD_RATE_WINDOW_MS", "conf", "dispatch.coord_rate_window_ms"),
	k("SUSPENDERS_COORD_WORKER_TIMEOUT_S", "conf"),
	k("SUSPENDERS_COPILOT_BIN", "conf"),
	k("SUSPENDERS_COPILOT_SETTINGS", "internal"),
	k("SUSPENDERS_CRED_SCOPE", "conf"),
	k("SUSPENDERS_CROSS_HUB_USAGE_TTL_MS", "conf"),
	k("SUSPENDERS_DECANT_DAILY_STATE", "internal"),
	k("SUSPENDERS_DEFAULT_HUB", "machine-conf", "stack.json (default hub)"),
	k("SUSPENDERS_DEMO", "conf"),
	k("SUSPENDERS_DONE_BROADCAST", "conf"),
	k("SUSPENDERS_DONE_DOCS", "conf", "gates.done_docs"),
	k("SUSPENDERS_DROP", "conf"),
	k("SUSPENDERS_DROP_DIR", "conf", "paths.drop_dir"),
	k("SUSPENDERS_DROP_MAX_BYTES", "conf"),
	k("SUSPENDERS_DROP_MAX_FILES", "conf"),
	k("SUSPENDERS_DROP_MAX_TOTAL", "conf"),
	k("SUSPENDERS_DROP_TTL_HOURS", "conf"),
	k("SUSPENDERS_EFFORT_POLICY", "conf"),
	k("SUSPENDERS_FEDERATION_WORK_TOKEN", "secret"),
	k("SUSPENDERS_FILLER", "conf"),
	k("SUSPENDERS_FLEET_DIR", "conf"),
	k("SUSPENDERS_GATE_CLIENT_PID", "internal"),
	k("SUSPENDERS_GATE_DAEMON", "conf", "gates.daemon"),
	k("SUSPENDERS_GATE_DAEMON_TIMEOUT_MS", "conf"),
	k("SUSPENDERS_GATE_WRITES", "conf"),
	k("SUSPENDERS_GC_DAYS", "conf"),
	k("SUSPENDERS_GROK_SETTINGS", "internal"),
	k("SUSPENDERS_HOME", "plumbing"),
	k("SUSPENDERS_HOLD_DRAIN", "conf", "dispatch.hold_drain"),
	k("SUSPENDERS_HUB", "machine-conf", "stack.json (hub profile)"),
	k("SUSPENDERS_HUBS_FILE", "plumbing"),
	k(
		"SUSPENDERS_HUB_IKEA_URL",
		"machine-conf",
		"hubs.json (per-label URL/TOKEN)",
	),
	k("SUSPENDERS_HUB_VIA", "machine-conf", "hubs.json (per-label URL/TOKEN)"),
	k(
		"SUSPENDERS_HUB_LOST_GRACE_MS",
		"conf",
		"fleet_loop.hub_lost_grace_ms (floor 60s)",
	),
	k("SUSPENDERS_IMPORT_LAW", "conf", "gates.import_law"),
	k("SUSPENDERS_INTERACTIVE_KEYS", "conf"),
	k("SUSPENDERS_KEV_CURATION_TIMEOUT_MS", "model-plane"),
	k("SUSPENDERS_KEV_URL", "conf", "knowledge.kev_url"),
	k("SUSPENDERS_KNOWLEDGE_DISTILL", "conf"),
	k("SUSPENDERS_KNOWLEDGE_KEY", "secret"),
	k("SUSPENDERS_KNOWLEDGE_KEY_FILE", "conf", "knowledge.sink.key_file"),
	k(
		"SUSPENDERS_KNOWLEDGE_SINK_TIMEOUT_MS",
		"conf",
		"knowledge.sink.timeout_ms",
	),
	k("SUSPENDERS_KNOWLEDGE_SINK_URL", "conf", "knowledge.sink.url"),
	k("SUSPENDERS_KNOWLEDGE_SYNC_STATE", "conf"),
	k("SUSPENDERS_KNOWLEDGE_VERIFY_TIMEOUT_MS", "conf"),
	k("SUSPENDERS_KNOWLEDGE_VERIFY_TOKEN", "secret"),
	k("SUSPENDERS_KNOWLEDGE_VERIFY_URL", "conf"),
	k("SUSPENDERS_KNOWLEDGE_WRITE_TOKEN", "secret"),
	k("SUSPENDERS_KNOWLEDGE_WRITE_TOKEN_FILE", "conf"),
	k("SUSPENDERS_LANE_DEADLINE_MS", "conf", "dispatch.lane_deadline_ms"),
	k("SUSPENDERS_LANE_EFFORT", "conf", "dispatch.lane_effort"),
	k("SUSPENDERS_LANE_GUARD", "conf"),
	k("SUSPENDERS_LANE_KEY_TIMEOUT_MS", "conf", "dispatch.lane_key_timeout_ms"),
	k("SUSPENDERS_LANE_MAX_ATTEMPTS", "conf", "dispatch.lane_max_attempts"),
	k("SUSPENDERS_LANE_STARTER", "conf"),
	k("SUSPENDERS_LEGACY", "conf"),
	k("SUSPENDERS_LLM_HOME", "model-plane"),
	k("SUSPENDERS_LLM_KEY", "secret"),
	k("SUSPENDERS_LLM_MODEL", "model-plane"),
	k("SUSPENDERS_LLM_URL", "model-plane"),
	k("SUSPENDERS_LOCAL_REGISTRY", "conf"),
	k("SUSPENDERS_MAINT_DETACH", "internal"),
	k("SUSPENDERS_MAINT_DETACH_DIR", "internal"),
	k("SUSPENDERS_MAINTENANCE", "conf", "fleet_loop.maintenance"),
	k("SUSPENDERS_MAINTENANCE_STAMPS", "internal"),
	k("SUSPENDERS_MAINTENANCE_STATE", "internal"),
	k("SUSPENDERS_MARKER", "conf"),
	k("SUSPENDERS_MAX_MUTATION", "conf", "gates.max_mutation_lines"),
	k("SUSPENDERS_MAX_READ", "conf", "gates.max_read_bytes"),
	k("SUSPENDERS_MDNS", "conf", "board.mdns"),
	k("SUSPENDERS_MEMORY_CONCURRENCY", "model-plane"),
	k("SUSPENDERS_MEMORY_EMBED_BATCH", "model-plane"),
	k("SUSPENDERS_MEMORY_EMBED_MODEL", "model-plane"),
	k("SUSPENDERS_MEMORY_EMBED_TOKEN", "secret"),
	k("SUSPENDERS_MEMORY_EMBED_URL", "model-plane"),
	k("SUSPENDERS_MEMORY_MAX_TOKENS", "model-plane"),
	k("SUSPENDERS_MEMORY_RPM", "model-plane"),
	k("SUSPENDERS_MEMORY_WAIT_MS", "model-plane"),
	k("SUSPENDERS_MERGE_STUCK_HOURS", "conf", "fleet_loop.merge_stuck_hours"),
	k("SUSPENDERS_MODEL_HEALTH", "conf"),
	k("SUSPENDERS_NO_HYPERLINK", "conf", "telemetry.no_hyperlink"),
	k("SUSPENDERS_NUDGE_COOLDOWN_MS", "conf", "gates.nudge_cooldown_ms"),
	k("SUSPENDERS_OBSERVATION_RELAYS", "machine-conf", "observation-relays.json"),
	k("SUSPENDERS_OUTAGE_LEDGER", "internal"),
	k("SUSPENDERS_PATCH_FIRST", "conf", "gates.patch_first"),
	k("SUSPENDERS_PLAID_LAUNCH_GAP_MS", "conf"),
	k("SUSPENDERS_PLAID_PRESSURE_HOLD", "conf", "dispatch.plaid_pressure_hold"),
	k("SUSPENDERS_PLAID_REFILL_BUDGET", "conf", "dispatch.plaid_refill_budget"),
	k("SUSPENDERS_PREFIX", "conf", "paths.suspenders_prefix"),
	k("SUSPENDERS_PROBE_DEPS", "conf"),
	k("SUSPENDERS_PROMPT_ENHANCE_KEY", "secret"),
	k("SUSPENDERS_PROMPT_ENHANCE_URL", "model-plane"),
	k("SUSPENDERS_PROMPT_MODEL", "model-plane"),
	k("SUSPENDERS_PUSH_TAIL", "conf"),
	k("SUSPENDERS_QUOTA_ZAI_CLASSES", "conf"),
	k("SUSPENDERS_RACE_POLICY", "conf"),
	k("SUSPENDERS_REINFORCEMENT_CLASS", "conf"),
	k("SUSPENDERS_RENAME_SYNC", "conf"),
	k("SUSPENDERS_REPO", "plumbing"),
	k("SUSPENDERS_REPORT_LINK_BASE", "conf", "telemetry.report_link_base"),
	k("SUSPENDERS_REPORT_STALL_MS", "conf", "board.report_stall_ms"),
	k("SUSPENDERS_REPORT_STATE_DIR", "internal"),
	k("SUSPENDERS_RISK_TIERS", "plumbing"),
	k(
		"SUSPENDERS_REPO_POLICY_CONFIG",
		"machine-conf",
		"per-repo policy (.prefer plane)",
	),
	k("SUSPENDERS_REREAD_NUDGE", "conf", "gates.reread_nudge"),
	k("SUSPENDERS_RESUME_RETAKE", "conf"),
	k("SUSPENDERS_RETAKE_TTL_MIN", "conf"),
	k("SUSPENDERS_REVIEW_BASE_SETTLE_MS", "conf", "review.base_settle"),
	k("SUSPENDERS_REVIEW_CANARY", "conf"),
	k("SUSPENDERS_REVIEW_CONCURRENCY", "conf"),
	k("SUSPENDERS_REVIEW_FALLBACK_MODELS", "conf"),
	k("SUSPENDERS_REVIEW_FAST_FAIL_MS", "conf"),
	k("SUSPENDERS_REVIEW_LEG_MAX_TOKENS", "conf"),
	k("SUSPENDERS_REVIEW_LEG_TIMEOUT_MS", "conf"),
	k("SUSPENDERS_REVIEW_LAUNCH_LOG", "internal"),
	k("SUSPENDERS_REVIEW_MODEL", "conf"),
	k("SUSPENDERS_REVIEW_RESCORE", "conf"),
	k("SUSPENDERS_REVIEW_PROOF_PARK_MS", "conf", "review.proof_park"),
	k("SUSPENDERS_REVIEW_RATE_BUDGET", "conf", "review.rate_budget"),
	k("SUSPENDERS_REVIEW_ROUND_CAP", "conf"),
	k("SUSPENDERS_REVIEW_STEPDOWN_CLASSES", "conf"),
	k("SUSPENDERS_REVIEW_TRANSPORT_PARK", "conf", "review.transport_park"),
	k("SUSPENDERS_REVIEW_WIRE_PARK_MS", "conf", "review.wire_park"),
	k("SUSPENDERS_ROLL_KEYS_FILE", "conf"),
	k("SUSPENDERS_RUNAWAY", "conf"),
	k("SUSPENDERS_RUNAWAY_FAIL_STREAK", "conf"),
	k("SUSPENDERS_RUNAWAY_QUIET_MS", "conf"),
	k("SUSPENDERS_RUNAWAY_REPEAT_MAX", "conf"),
	k("SUSPENDERS_RUNAWAY_SCAN_CAP_BYTES", "conf"),
	k("SUSPENDERS_RUNAWAY_TAIL_BYTES", "conf"),
	k("SUSPENDERS_RUNAWAY_USD_CAP", "conf"),
	k("SUSPENDERS_RUNAWAY_USD_RATES", "conf"),
	k("SUSPENDERS_SCRUB", "conf", "gates.scrub"),
	k("SUSPENDERS_SCRUB_DENYLIST", "conf", "gates.scrub_denylist"),
	k("SUSPENDERS_SELF_HUB_LABEL", "conf", "telemetry.self_hub_label"),
	k(
		"SUSPENDERS_SERVICES_JSON",
		"machine-conf",
		"services.yaml (deploy manifest)",
	),
	k(
		"SUSPENDERS_SERVICE_PORTS_JSON",
		"machine-conf",
		"services.yaml (deploy manifest)",
	),
	k("SUSPENDERS_SESSION_CONTRACT", "conf"),
	k("SUSPENDERS_SESSION_IDENTITY_PROTOCOL", "conf"),
	k("SUSPENDERS_SHIM_BIN", "conf", "paths.shim_bin"),
	k("SUSPENDERS_SID", "plumbing"),
	k("SUSPENDERS_SIGNALS_SCAN", "conf"),
	k("SUSPENDERS_SKILL_LOG", "conf"),
	k("SUSPENDERS_SQL_LLM_KEY", "secret"),
	k("SUSPENDERS_SQL_LLM_MODEL", "model-plane"),
	k("SUSPENDERS_SQL_LLM_TIMEOUT_MS", "model-plane"),
	k("SUSPENDERS_SQL_LLM_URL", "model-plane"),
	k("SUSPENDERS_STEER_MIN_INTERVAL_S", "conf", "steer.min_interval_s"),
	k("SUSPENDERS_SUBSCRIBE_MODE", "conf"),
	k("SUSPENDERS_SUGGEST_URL", "model-plane"),
	k("SUSPENDERS_SYNC_ALLOW_BRANCH", "conf"),
	k("SUSPENDERS_TIDY", "conf"),
	k("SUSPENDERS_TRAILER_GATE", "conf", "gates.trailer_gate"),
	k("SUSPENDERS_TRANSPORT_PROBE", "conf"),
	k("SUSPENDERS_TRANSPORT_PROBE_TTL_MS", "conf"),
	k("SUSPENDERS_TWO_PERSON", "conf"),
	k("SUSPENDERS_WATCHDOG_REPO", "conf"),
	k("SUSPENDERS_WATCHDOG_SID", "conf"),
	k("SUSPENDERS_WORK_CLI", "conf"),
	k("SUSPENDERS_WRITE_TOKEN_FILE", "secret"),
];

/** Prefix families: template-shaped knobs (SUSPENDERS_HUB_<LABEL>_TOKEN ...)
 *  resolve through the family home instead of an exact row. */
export const KNOB_FAMILY_PREFIXES: readonly [string, KnobHome][] = [
	[
		"SUSPENDERS_HUB_",
		{
			env: "SUSPENDERS_HUB_",
			kind: "machine-conf",
			detail: "hubs.json (per-label URL/TOKEN)",
		},
	],
	[
		"SUSPENDERS_DROP_",
		{
			env: "SUSPENDERS_DROP_",
			kind: "conf",
			detail: "settings (board drop limits, rows pending)",
		},
	],
	[
		"SUSPENDERS_LEGACY_",
		{
			env: "SUSPENDERS_LEGACY_",
			kind: "plumbing",
			detail: "install-time env handoff (plumbing)",
		},
	],
	[
		"SUSPENDERS_FIXTURE_",
		{
			env: "SUSPENDERS_FIXTURE_",
			kind: "plumbing",
			detail: "test seam (plumbing)",
		},
	],
	[
		"SUSPENDERS_CLAIM_",
		{
			env: "SUSPENDERS_CLAIM_",
			kind: "plumbing",
			detail: "test seam (plumbing)",
		},
	],
];

const EXACT: ReadonlyMap<string, KnobHome> = new Map(
	KNOB_REGISTRY.map((r) => [r.env, r]),
);

/** The designated home for a knob, or undefined when undeclared (a guard
 *  failure — every prod SUSPENDERS_* knob must resolve). */
export function knobHome(name: string): KnobHome | undefined {
	const exact = EXACT.get(name);
	if (exact) return exact;
	const fam = KNOB_FAMILY_PREFIXES.find(([p]) => name.startsWith(p));
	return fam?.[1];
}
