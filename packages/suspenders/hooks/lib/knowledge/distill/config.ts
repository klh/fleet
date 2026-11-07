// distill/config.ts — the idle distiller's machine config (hub design fork
// G). Config-over-code: every threshold, window, weight and endpoint lives
// in the machine conf under `knowledge.distill`; the repo carries these
// defaults only. The schema is the single source of truth (Schema law
// W1238.4): a malformed block disables the distiller LOUDLY (status shows
// the prettified issue) instead of running on half-parsed values.
// W2582: DistillConfigSchema moved verbatim into @klh/settings (it IS the
// settings knowledge.distill section) — this file keeps the loading
// posture over the ONE schema; a malformed block = defaults (disabled) +
// the issue. The reader fails closed either way.
import { z } from "zod";
import {
	DistillConfigSchema as SettingsDistillConfigSchema,
	distillDefaults,
} from "@klh/settings";
import type { DistillConfig } from "@klh/settings";
import { tryLoadStack } from "../../stack-config.ts";

export const DistillConfigSchema = SettingsDistillConfigSchema;
export type { DistillConfig };

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

/** Defaults with every override applied (tests and the empty machine) —
 *  re-exported from @klh/settings (the ONE schema lives there, W2582). */
export { distillDefaults };

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
): {
	hash: number;
	usage: number;
	neighbours: number;
	origin: number;
	minRevisit: number;
} => ({
	hash: c.weights.hash_changed_h * HOUR,
	usage: c.weights.usage_rose_h * HOUR,
	neighbours: c.weights.neighbours_changed_h * HOUR,
	origin: c.weights.origin_prior_h * HOUR,
	minRevisit: c.min_revisit_h * HOUR,
});
