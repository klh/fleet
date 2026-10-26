#!/usr/bin/env bun
// hooks/bin/launch-janitor.ts — CLI face of the W1247 .fleet launch-debris
// janitor (hooks/lib/fleet-loop/launch-janitor.ts). Prunes launch-<nonce>.{json,sh}
// + .json.registered debris older than --max-age-days (default 7) from
// <repo>/.fleet, keeping every nonce whose lane_launch_intents row is not
// provably dead (uncertainty keeps — a mid-flight or foreign-host launch
// never loses its files). Dry-run is the default; the fleet-loop W779
// registry fires it with --act daily. Exit 1 when a dry-run finds
// candidates (a human or cron should notice), 2 when the governor store
// is unavailable (fail-closed: no store = no pruning, protects live lanes).
import { openStore } from "../lib/govdb/govdb.ts";
import { createLaunchJanitor } from "../lib/fleet-loop/launch-janitor.ts";
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import { inspectLaunchIntent } from "../../scripts/lib/launch-fencing.ts";
import type { LaunchIntent } from "../../scripts/lib/launch-fencing.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "launch-janitor",
	usage:
		"usage: bun launch-janitor.ts [--act] [--json] [--repo <dir>] [--max-age-days <n>] [--max-prune <n>]",
	flags: ["--repo", "--max-age-days", "--max-prune"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("launch-janitor")(outcome.message || (SPEC.usage ?? ""));
const act = outcome.parsed.flag("--act") === "true";
const json = outcome.parsed.flag("--json") === "true";
const val = (flag: string): string | undefined =>
	outcome.parsed.flag(flag) ?? undefined;

const repo = val("--repo") ?? process.cwd();
const ageArg = Number(val("--max-age-days") ?? 7);
const maxAgeDays = Number.isFinite(ageArg) && ageArg > 0 ? ageArg : 7;
const pruneArg = Number(val("--max-prune") ?? NaN);
const maxPrune =
	Number.isFinite(pruneArg) && pruneArg > 0 ? pruneArg : undefined;

let store: ReturnType<typeof openStore> | null = null;
try {
	store = openStore();
} catch {
	store = null;
}
if (store === null) {
	console.error(
		"launch-janitor: governor store unavailable — refusing to prune (fail-closed keep)",
	);
	process.exit(2);
}

const rows = store
	.query("SELECT * FROM lane_launch_intents")
	.all() as unknown as LaunchIntent[];

const { sweep } = createLaunchJanitor({
	repo,
	act,
	maxAgeDays,
	maxPrune,
	intents: (): LaunchIntent[] => rows,
	inspect: inspectLaunchIntent,
	log: (msg: string): void => {
		console.log(msg);
	},
});

const report = sweep();

if (act && !report.paused && report.pruned.length > 0) {
	emitLoopEvent(
		"plane.launchjanitor",
		"plane",
		{
			pruned: report.pruned.length,
			kept: report.kept,
			keptCurrent: report.keptCurrent,
			scanned: report.scanned,
		},
		store,
	);
}

if (json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	for (const row of report.pruned)
		console.log(
			`${report.dryRun ? "would " : ""}prune ${row.file} — ${row.ageDays}d old`,
		);
	for (const err of report.errors) console.error(err);
	console.log(
		`${report.scanned} launch file(s), ${report.groups} nonce(s), ` +
			`kept ${report.kept + report.keptCurrent} (${report.keptCurrent} registered-current), ` +
			`pruned ${report.pruned.length}${report.overflow > 0 ? `, overflow ${report.overflow}` : ""}` +
			(report.paused ? " · PAUSED" : report.dryRun ? " · dry-run" : " · acted"),
	);
}
store.close();
const attention = report.pruned.length > 0 ? 1 : 0;
process.exit(!act && attention ? 1 : 0);
