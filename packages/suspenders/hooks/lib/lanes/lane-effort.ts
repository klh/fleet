// hooks/lib/lanes/lane-effort.ts — W909: the lane's effort level. Dispatch stamps
// SUSPENDERS_LANE_EFFORT into the per-lane 0600 settings (lane-settings.ts);
// `work done` banks it into the work.done event payload, and the reporter's
// EFFORT column replays it (work-timing). The same lib owns the item link the
// CONSULT column reads: a lane banking knowledge (knowledge-enqueue) or
// asking a consult stamps its current claim into the event payload. Fail-soft
// everywhere: no env/file/claim = no stamp, never a report blocker.
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** The effort from a lane's 0600 settings file (JSON env grammar); null when
 *  absent/unreadable. Values are short free-form (low/medium/high/...). */
export const laneEffortFromSettingsFile = (path: string): string | null => {
	try {
		const s = JSON.parse(readFileSync(path, "utf8")) as {
			env?: Record<string, string>;
		};
		const v = s.env?.SUSPENDERS_LANE_EFFORT;
		return typeof v === "string" && v ? v : null;
	} catch {
		return null; // absent/foreign/unreadable — fail soft
	}
};

/** done-time effort stamp: process env first (the lane closing its own item
 *  rides the settings env), then the persisted 0600 settings file (a
 *  supervisor closing a lane's item after spawn). Empty record = no effort. */
export const doneEffortStamp = (
	fleetDir: string,
	sid: string,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
	const v =
		env.SUSPENDERS_LANE_EFFORT ??
		laneEffortFromSettingsFile(`${fleetDir}/lane-settings-${sid}.json`);
	return v ? { effort: v } : {};
};

/** The item a sid currently claims (W909 item link): CLAIMED/RUNNING owner of
 *  record, most recent first. null = no live claim (the link stays unstamped). */
export const claimedWorkOf = (
	db: Database,
	project: string,
	sid: string | null | undefined,
): string | null => {
	if (!sid) return null;
	try {
		const r = db
			.query(
				"SELECT id FROM work_items WHERE project = ? AND owner_sid = ? AND state IN ('CLAIMED','RUNNING') ORDER BY updated_at DESC LIMIT 1",
			)
			.all(project, sid) as { id: string }[];
		return r[0]?.id ?? null;
	} catch {
		return null; // no graph table (tests) — fail soft
	}
};

/** W923: the dispatch default — item priority to a short effort word the 0600
 *  settings pin carries. env SUSPENDERS_LANE_EFFORT overrides it (dispatch env
 *  wins over the derived default in lane-settings.ts). */
export const effortForPriority = (
	priority: number | null | undefined,
): string => {
	if (priority === null || priority === undefined) return "medium";
	if (priority <= 1) return "high";
	if (priority === 2) return "medium";
	return "low";
};
