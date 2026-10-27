#!/usr/bin/env bun
// hooks/bin/activity-harvest.ts — W657 thin face: the collector library is
// hooks/lib/harvest/activity-harvest.ts (activityAdapter rides the W657 engine
// pipeline); scheduling is the ONE shared gate maybeHarvest (usage lib).
// w159: govdb opens LAZILY inside main.
//   bun hooks/bin/activity-harvest.ts [--force] [--weeks N]
// Prints {harvest, meter} — the harvest field is the pipeline's usage-stats
// face (activity rides the same gated pass; meter output is unchanged).
import { activityReport } from "../lib/harvest/activity-harvest.ts";
import { maybeHarvest } from "../lib/usage/usage-harvest.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

if (import.meta.main) {
	const outcome = parseVerb(
		defineVerb({
			name: "activity-harvest",
			usage: "bun hooks/bin/activity-harvest.ts [--force] [--weeks N]",
			switches: ["--force"],
			flags: ["--weeks"],
			lax: true,
		}),
		process.argv.slice(2),
	);
	if (!outcome.ok) {
		console.error(
			outcome.message ||
				"bun hooks/bin/activity-harvest.ts [--force] [--weeks N]",
		);
		process.exit(2);
	}
	const { openStore } = await import("../lib/govdb/govdb.ts");
	const db = openStore();
	const force = outcome.parsed.rest.includes("--force");
	const weeksRaw = outcome.parsed.flag("--weeks");
	const weeks = weeksRaw !== null ? Number(weeksRaw) : undefined;
	const s = maybeHarvest(db, force ? 0 : undefined);
	console.log(
		JSON.stringify({
			harvest: s,
			meter: activityReport(db, { weeks: weeks ?? 8 }),
		}),
	);
}
