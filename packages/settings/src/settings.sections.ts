// settings.sections.ts — the behaviour sections of SettingsSchema (every
// knob a fleet component reads). Topology (hubs) and the absorbed
// stack.json documents live in settings.hubs.ts / settings.stack.ts. Each
// leaf: bounds + .default() + .describe(); each section strict (unknown key
// = loud failure). Defaults mirror the code defaults the env knobs fell back
// to, so an empty settings.json changes nothing on install.
import { z } from "zod";
import {
	bool,
	int,
	list,
	num,
	oneOf,
	opt,
	path,
	section,
	str,
} from "./settings.leaf.ts";

/** One registered repo the hub's fleet-loop supervises (fork E, W2242). */
export const FleetLoopProjectSchema = z
	.object({
		path: z.string().min(1).describe("Repo checkout path (~/ expands)"),
		glob: opt("Branch glob the merge ladder considers"),
		ladder: opt("Merge ladder name for this repo"),
		dispatch_cmd: opt("Dispatch command override for this repo"),
		main: opt("Main branch name (default: the repo's HEAD branch)"),
		lane_target: z
			.number()
			.int()
			.min(0)
			.max(200)
			.optional()
			.describe("Per-repo lane sub-cap under fleet_loop.lane_target"),
		enabled: bool(true, "Supervise this repo"),
	})
	.strict();

export const FleetLoopSchema = section(
	{
		lane_target: int(
			1,
			200,
			6,
			"Global live-lane ceiling across every registered repo",
		),
		dispatch_target: int(1, 200, 8, "Dispatch refill target per cycle"),
		every_s: int(10, 3600, 120, "Fleet-loop cycle cadence (seconds)"),
		config_poll_s: int(1, 600, 10, "Config re-read interval (seconds)"),
		maintenance: bool(true, "Run the maintenance task set each cycle"),
		merge_stuck_hours: int(1, 168, 6, "Merge-ladder stuck alarm age (hours)"),
		projects: z
			.array(FleetLoopProjectSchema)
			.max(64)
			.default([])
			.describe("Registered repos (empty = the --repo arg only)"),
	},
	"The hub supervisor loop: lane caps, cadence, registered repos",
);

export const ConsultSchema = section(
	{
		feedback: section(
			{
				require_on_done: bool(
					false,
					"Block `work done` while a knowledge answer this lane received is unreported",
				),
			},
			"Knowledge-answer feedback obligation",
		),
		interrupt: section(
			{
				min_interval_s: int(
					120,
					300,
					180,
					"Min seconds between interrupts (steers) per recipient",
				),
				per_sender_min_interval_s: int(
					120,
					300,
					180,
					"Min seconds between interrupts per sender",
				),
			},
			"High-priority direct consults delivered as steers",
		),
		oracle: section(
			{
				min_trust: oneOf(
					["candidate", "active"],
					"candidate",
					"Lowest knowledge state the oracle may answer from (candidate answers are marked unreviewed)",
				),
			},
			"Oracle pre-check before consult delivery",
		),
		spawn_timeout_ms: int(
			1000,
			600_000,
			30_000,
			"Board consult spawn timeout (ms)",
		),
		max_concurrent: int(1, 64, 2, "Concurrent board consult spawns"),
		federation_file: opt("Consult federation peers file"),
	},
	"Consult routing, interrupts and feedback",
);

export const DistillSchema = section(
	{
		enabled: bool(false, "Run the idle-time knowledge distiller on this hub"),
		idle_lanes_max: int(
			0,
			64,
			1,
			"Max live lanes for the hub to count as idle",
		),
		quiet_minutes: int(1, 1440, 15, "Minutes of quiet before a run starts"),
		window: z
			.string()
			.regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/)
			.optional()
			.describe("Optional HH:MM-HH:MM window the distiller may run in"),
		model_group: str(
			"distill",
			"Buckle model group the distiller asks (map it in routing policy)",
		),
		token_budget_per_day: int(
			0,
			100_000_000,
			200_000,
			"Daily token budget for distillation",
		),
		max_job_ms: int(1000, 3_600_000, 600_000, "Max wall time per job (ms)"),
		max_visit_age_days: int(
			1,
			365,
			30,
			"Every entry is revisited within this many days (else overdue)",
		),
	},
	"Idle-time knowledge walker/distiller",
);

export const KnowledgeSchema = section(
	{
		downvote_threshold: int(
			1,
			20,
			2,
			"Distinct failed-feedback lanes before an entry leaves answering",
		),
		kev_timeout_ms: int(
			100,
			120_000,
			8000,
			"Kev curation timeout before the review queue",
		),
		kev_url: str("http://127.0.0.1:8912", "Kev specialist base URL"),
		sink: section(
			{
				url: opt("Hub knowledge sink origin"),
				key_file: opt("0600 file holding the sink bksk_ key (never inline)"),
				timeout_ms: int(100, 60_000, 2000, "Sink request timeout (ms)"),
			},
			"Hub knowledge sink client",
		),
		distill: DistillSchema,
	},
	"Knowledge store, Kev curation, sink, distiller",
);

export const BoardSchema = section(
	{
		poll_memo_ms: int(0, 60_000, 1000, "Polled-feed refresh floor (0 = off)"),
		sync_floor_ms: int(0, 600_000, 5000, "syncDecisions refresh floor (ms)"),
		sync_idle_ms: int(0, 3_600_000, 30_000, "syncDecisions idle re-check (ms)"),
		front_timeout_ms: int(100, 10_000, 600, "Buckle front probe bound (ms)"),
		report_stall_ms: int(
			60_000,
			86_400_000,
			7_200_000,
			"Lane silence before work report lists it under needs-you",
		),
		mdns: bool(true, "Announce the board over mDNS (demo boards never do)"),
	},
	"Fleet board (:7799)",
);

export const GatesSchema = section(
	{
		max_read_bytes: int(
			0,
			64 * 1024 * 1024,
			40 * 1024,
			"Read-gate cap (0 = off)",
		),
		reread_nudge: bool(true, "Nudge on repeated full re-reads"),
		max_mutation_lines: int(0, 100_000, 40, "Mutation-size cap (0 = off)"),
		coordinator_edit_gate: bool(true, "Deny coordinator structural writes"),
		scrub: bool(true, "Scrub gate on commit/push"),
		scrub_denylist: path(
			"~/.claude/local-llm/scrub-denylist",
			"Machine-local scrub denylist",
		),
		patch_first: bool(true, "Near-cap patch-first done check"),
		import_law: bool(true, "Import-law done check"),
		done_docs: bool(true, "Bench-docs done check"),
		trailer_gate: oneOf(
			["enforce", "audit", "off"],
			"audit",
			"Lane commit trailer gate mode",
		),
		advisory_cooldown_ms: int(
			0,
			86_400_000,
			300_000,
			"Repeat advisory suppression TTL (0 = off)",
		),
		nudge_cooldown_ms: int(0, 86_400_000, 300_000, "Hook nudge cooldown"),
		context_guard_pct: int(1, 100, 75, "Stop-gate context warning (%)"),
		context_critical_pct: int(1, 100, 95, "Stop-gate context critical (%)"),
		daemon: bool(false, "Run gates in the store-server daemon (fork B)"),
	},
	"Hook gates (read, mutation, scrub, done checks)",
);

export const SteerSchema = section(
	{
		min_interval_s: int(60, 3600, 180, "Min seconds between steers per lane"),
	},
	"Mid-turn steer delivery",
);

export const BuckleSchema = section(
	{
		retry_after_cap_s: int(
			0,
			3600,
			60,
			"Clamp on a provider Retry-After before relaying",
		),
		retry_after_s: int(1, 3600, 2, "Retry-After emitted on local shedding"),
		retry_after_max_s: int(1, 86_400, 3600, "Max Retry-After buckle emits"),
		max_inflight: int(1, 100_000, 256, "Admission in-flight ceiling"),
		slot_lease_ms: int(1000, 3_600_000, 120_000, "Admission slot lease (ms)"),
		affinity: bool(true, "Prefix-cache affinity routing"),
		affinity_ttl_s: int(1, 86_400, 300, "Affinity TTL (seconds)"),
		failover_max_hops: int(0, 8, 1, "Immediate failover hops per request"),
		quota_wall_codes: list(
			["1113"],
			"Provider codes meaning balance/plan exhaustion (long cooldown, dispatch stop)",
		),
		concurrency_error_codes: list(
			["1302", "1305"],
			"Provider codes for concurrency/rate pressure (shrink concurrency, never a quota wall; W1257 still needs message evidence for concurrency)",
		),
		breaker: section(
			{
				failure_threshold: int(1, 1000, 5, "Failures before the breaker opens"),
				open_ms: int(
					100,
					3_600_000,
					30_000,
					"Open (cold) period before one probe",
				),
			},
			"Per-upstream circuit breaker",
		),
		shedding: section(
			{
				queue_max: int(0, 100_000, 32, "Bounded admission queue length"),
				queue_wait_ms: int(0, 120_000, 2000, "Max queue wait before 503"),
				interactive_reserved_share: num(
					0,
					1,
					0.25,
					"Capacity share reserved for interactive keys",
				),
			},
			"Load shedding (503/429 + Retry-After)",
		),
	},
	"Buckle gateway resilience, admission and shedding knobs",
);

export const DispatchSchema = section(
	{
		lane_effort: oneOf(
			["low", "medium", "high", "xhigh", "max"],
			"medium",
			"Default lane effort level",
		),
		lane_max_attempts: int(1, 100, 3, "Launch attempts per item"),
		lane_deadline_ms: int(
			1000,
			86_400_000,
			900_000,
			"Route preflight deadline",
		),
		lane_key_timeout_ms: int(100, 120_000, 5000, "Per-lane key mint timeout"),
		plaid_pressure_hold: bool(false, "Hold plaid dispatch under pressure"),
		coord_max_peers: int(1, 64, 2, "Peer coordination fan cap"),
		coord_rate_window_ms: int(1000, 3_600_000, 60_000, "Coordination window"),
		coord_rate_max: int(1, 1000, 3, "Coordination rounds per window"),
	},
	"Lane dispatch",
);

export const PathsSchema = section(
	{
		local_llm_home: path("~/.claude/local-llm", "local-llm runtime home"),
		routing_policy: path(
			"~/.claude/local-llm/routing-policy.json",
			"Operator routing ladder (separate data file, not knobs)",
		),
		upstreams: path(
			"~/.claude/local-llm/upstreams.json",
			"Upstream group overrides (separate data file, not knobs)",
		),
		repo_tier_policy: opt("Buckle repo→tier account policy file"),
		suspenders_prefix: path(
			"~/.claude/hooks/suspenders",
			"Installed suspenders prefix",
		),
		shim_bin: path("~/.local/bin", "Where coord/work/dispatch shims go"),
		governor_dir: path("~/.cache/claude-governor", "governor.db directory"),
		decant_db: path("~/.decant/decant.db", "Decant transcript archive"),
		drop_dir: opt("Drop directory for handoffs"),
	},
	"Filesystem locations",
);

export const TelemetrySchema = section(
	{
		log_level: oneOf(
			["debug", "info", "warn", "error"],
			"info",
			"Service log level",
		),
		no_hyperlink: bool(false, "Disable OSC-8 hyperlinks in CLI output"),
		report_link_base: opt("Base URL for work report deep links"),
		self_hub_label: str("mac", "Label this machine renders as in reports"),
		cache_telemetry: bool(true, "Emit prompt-cache telemetry rows"),
	},
	"Logging and reporting",
);
