// distill/config.ts — the idle distiller's machine config (hub design fork
// G). Config-over-code: every threshold, window, weight and endpoint lives
// in the machine stack.json under `knowledge.distill`; the repo carries
// these defaults only. The schema is the single source of truth (Schema law
// W1238.4): a malformed block disables the distiller LOUDLY (status shows
// the prettified issue) instead of running on half-parsed values.
import { z } from "zod";
import { tryLoadStack } from "../../stack-config.ts";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DistillWindowSchema = z
	.object({
		/** local "HH:MM" — runs only inside [start, end); wraps midnight */
		start: z.string().regex(HHMM),
		end: z.string().regex(HHMM),
	})
	.strict();

/** The hub's load signal: buckle's in-flight/pressure read when it exists
 *  (JSON `field`, dot path), else the router's Prometheus /metrics (sum of
 *  the `field` series). Unreachable = busy — the distiller never guesses. */
export const PressureProbeSchema = z
	.object({
		url: z.url(),
		format: z.enum(["json", "prometheus"]).default("json"),
		field: z.string().min(1).default("inflight"),
		/** idle only while the read value is <= max */
		max: z.number().min(0).default(0),
		timeout_ms: z.number().int().min(100).max(10_000).default(2000),
	})
	.strict();

export const DistillWeightsSchema = z
	.object({
		/** hours added to an entry's age when its content hash changed */
		hash_changed_h: z.number().min(0).default(72),
		/** hours added when its recall/usage count rose since the last visit */
		usage_rose_h: z.number().min(0).default(24),
		/** hours added when an edge touching it was written since the visit */
		neighbours_changed_h: z.number().min(0).default(12),
	})
	.strict();

export const DistillConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		/** idle only while live lanes <= this */
		idle_lanes_max: z.number().int().min(0).default(0),
		/** idle only after this many minutes without interactive activity */
		quiet_minutes: z.number().min(0).default(15),
		window: DistillWindowSchema.optional(),
		/** the buckle model group the LLM jobs ride (the hub's strongest) */
		model_group: z.string().min(1).default("glm-5.3"),
		token_budget_per_day: z.number().int().min(0).default(200_000),
		/** wall budget per job per run */
		max_job_ms: z.number().int().min(1000).default(600_000),
		/** entries per job per run */
		batch: z.number().int().min(1).max(500).default(25),
		/** starvation guard: every entry visited within this many days */
		max_age_days: z.number().min(1).default(30),
		/** an unchanged entry is not revisited sooner than this */
		min_revisit_h: z.number().min(0).default(24),
		weights: DistillWeightsSchema.prefault({}),
		pressure: PressureProbeSchema.optional(),
		/** embeddings endpoint (the :8907 specialist) */
		embed_url: z.url().default("http://127.0.0.1:8907/v1/embeddings"),
		embed_model: z.string().min(1).default("local-embed"),
		/** rerank endpoint (the :8913 specialist); absent = cosine only */
		rerank_url: z.url().optional(),
		rerank_model: z.string().min(1).default("local-rerank"),
		neighbours_k: z.number().int().min(1).max(64).default(8),
		related_min: z.number().min(0).max(1).default(0.62),
		duplicate_min: z.number().min(0).max(1).default(0.93),
		cluster_min: z.number().min(0).max(1).default(0.75),
		cluster_size_min: z.number().int().min(2).default(3),
		cluster_size_max: z.number().int().min(2).max(20).default(8),
		/** pairs judged per entry per contradiction visit */
		contradiction_pairs: z.number().int().min(1).max(10).default(3),
		/** the machine's decant.db (read-only); absent = source skipped */
		decant_db: z.string().min(1).optional(),
		/** sessions a command set must recur in before it is a script */
		decant_script_min_sessions: z.number().int().min(2).default(3),
		/** roots the staleness job resolves source_ref files against */
		repo_roots: z.array(z.string().min(1)).default([]),
		/** kill switch — present = every run is a no-op */
		pause_file: z.string().min(1).default(".fleet/distill-paused"),
		/** NDJSON run log; absent = <governor registry>/distill-runs.jsonl */
		log_path: z.string().min(1).optional(),
		/** watch-mode cadence */
		interval_s: z.number().int().min(30).default(300),
	})
	.strict();

export type DistillConfig = z.infer<typeof DistillConfigSchema>;

const StackDistillSchema = z
	.object({
		knowledge: z
			.object({ distill: DistillConfigSchema.optional() })
			.loose()
			.optional(),
	})
	.loose();

export interface LoadedDistillConfig {
	config: DistillConfig;
	/** prettified schema issue — present means the block was refused */
	issue: string | null;
}

/** Defaults with every override applied (tests and the empty machine). */
export const distillDefaults = (
	over: Partial<z.input<typeof DistillConfigSchema>> = {},
): DistillConfig => DistillConfigSchema.parse(over);

/** Read `knowledge.distill` from the machine stack.json. Absent block =
 *  defaults (disabled); malformed block = defaults (disabled) + the issue. */
export function loadDistillConfig(
	stack: unknown = tryLoadStack(),
): LoadedDistillConfig {
	const parsed = StackDistillSchema.safeParse(stack ?? {});
	if (!parsed.success)
		return {
			config: distillDefaults(),
			issue: z.prettifyError(parsed.error),
		};
	return {
		config: parsed.data.knowledge?.distill ?? distillDefaults(),
		issue: null,
	};
}

/** THE accessor every production path reads the distiller's knobs through.
 *  Today it parses `knowledge.distill` out of the machine stack.json with
 *  DistillConfigSchema; when the per-install settings.json (@klh/settings)
 *  lands, only this body changes to `setting("knowledge.distill")`. */
export function distillSettings(): LoadedDistillConfig {
	return loadDistillConfig();
}

const HOUR = 3_600_000;

/** Scheduler weights in milliseconds (age is the base score). */
export const weightsMs = (
	c: DistillConfig,
): { hash: number; usage: number; neighbours: number; minRevisit: number } => ({
	hash: c.weights.hash_changed_h * HOUR,
	usage: c.weights.usage_rose_h * HOUR,
	neighbours: c.weights.neighbours_changed_h * HOUR,
	minRevisit: c.min_revisit_h * HOUR,
});
