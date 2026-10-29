// hooks/lib/consult/consult-config.ts — hub design phase 4: the consult +
// steer delivery knobs. Config-over-code: machine-level JSON at
// ~/.config/klh/coord.json (SUSPENDERS_COORD_CONFIG overrides the path),
// zod-parsed — out-of-bounds or malformed config fails LOUD on stderr and
// the defaults ride (schema law: drift never silently becomes a value).
//
//   { "consult": { "interrupt": { "min_interval_s": 180,
//                                 "sender_min_interval_s": 180,
//                                 "ack_timeout_s": 180 },
//                  "feedback": { "require_on_done": false } },
//     "steer": { "min_interval_s": 180 },
//     "knowledge": { "downvote_threshold": 2 } }
//
// Owner correction 2026-10-29: one interrupt per recipient every 2–5 min
// (default 180 s, bounded 120–300), per-sender cap of the same shape; the
// steer gate's interval is its own knob in the same family.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const intervalS = z.number().int().min(120).max(300).prefault(180);

export const CoordConfigSchema = z.object({
	consult: z
		.object({
			interrupt: z
				.object({
					min_interval_s: intervalS,
					sender_min_interval_s: intervalS,
					ack_timeout_s: z.number().int().min(30).max(1800).prefault(180),
				})
				.prefault({}),
			feedback: z
				.object({ require_on_done: z.boolean().prefault(false) })
				.prefault({}),
		})
		.prefault({}),
	steer: z
		.object({
			min_interval_s: z.number().int().min(60).max(3600).prefault(180),
		})
		.prefault({}),
	knowledge: z
		.object({ downvote_threshold: z.number().int().min(1).max(20).prefault(2) })
		.prefault({}),
});
export type CoordConfig = z.infer<typeof CoordConfigSchema>;

export const DEFAULT_COORD_CONFIG: CoordConfig = CoordConfigSchema.parse({});

export function coordConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.SUSPENDERS_COORD_CONFIG ||
		join(env.HOME ?? homedir(), ".config", "klh", "coord.json")
	);
}

/** Parse a raw config value; a parse failure names the drift and yields the
 *  defaults (never a partially-coerced config). */
export function parseCoordConfig(
	raw: unknown,
	warn: (msg: string) => void = (m) => console.error(m),
): CoordConfig {
	const r = CoordConfigSchema.safeParse(raw ?? {});
	if (r.success) return r.data;
	warn(`coord config rejected — defaults apply: ${z.prettifyError(r.error)}`);
	return DEFAULT_COORD_CONFIG;
}

export function loadCoordConfig(
	env: NodeJS.ProcessEnv = process.env,
	warn?: (msg: string) => void,
): CoordConfig {
	let raw: unknown = {};
	try {
		raw = JSON.parse(readFileSync(coordConfigPath(env), "utf8"));
	} catch (e) {
		const code = (e as { code?: string }).code;
		if (code !== "ENOENT")
			(warn ?? ((m: string) => console.error(m)))(
				`coord config unreadable — defaults apply: ${(e as Error).message}`,
			);
	}
	return parseCoordConfig(raw, warn);
}

export const steerIntervalMs = (c: CoordConfig): number =>
	c.steer.min_interval_s * 1000;

const memo = new Map<string, CoordConfig>();
/** THE accessor every phase-4 module reads its knobs through (one per
 *  module family): when the central @klh/settings lands (fork H), only this
 *  body swaps to `setting("consult.…")` — call sites stay. */
export function coordSettings(
	env: NodeJS.ProcessEnv = process.env,
): CoordConfig {
	const path = coordConfigPath(env);
	const hit = memo.get(path);
	if (hit) return hit;
	const cfg = loadCoordConfig(env);
	memo.set(path, cfg);
	return cfg;
}
