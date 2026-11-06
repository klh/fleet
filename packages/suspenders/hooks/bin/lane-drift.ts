#!/usr/bin/env bun
// hooks/bin/lane-drift.ts — W2787: lane-class behavioral drift sweep.
// Read-only detection: replays work.review / work.done / work.retried /
// completion-block events into per-lane-class windows (current vs previous)
// and prints the baseline; --emit publishes one idempotent `lane.drift`
// event per alert (board feed + pulse pick it up). Exit 1 when any class
// drifted (metrics-alert convention), 0 otherwise.
import { emitStoredEvent } from "../coord/event-publish.ts";
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";
import {
	computeDrift,
	DRIFT_DEFAULTS,
	driftLine,
	emitDriftAlerts,
	readDriftRows,
} from "../lib/work/lane-drift.ts";

const SPEC = defineVerb({
	name: "lane-drift",
	usage:
		"usage: bun lane-drift.ts [--json] [--emit] [--window-days N] [--min-samples N] [--threshold PTS] [--project <id>]",
	flags: ["--window-days", "--min-samples", "--threshold", "--project"],
	switches: ["--json", "--emit"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("lane-drift")(outcome.message || (SPEC.usage ?? ""));
const { flag } = outcome.parsed;
const num = (name: string, fallback: number): number => {
	const v = Number(flag(name));
	return flag(name) !== null && Number.isFinite(v) && v > 0 ? v : fallback;
};

const opts = {
	now: Date.now(),
	windowMs:
		num("--window-days", DRIFT_DEFAULTS.windowMs / 86_400_000) * 86_400_000,
	minSamples: num("--min-samples", DRIFT_DEFAULTS.minSamples),
	thresholdPts: num("--threshold", DRIFT_DEFAULTS.thresholdPts),
};
const project = flag("--project") ?? projectIdentity();
const db = openStore();
const classes = computeDrift(
	readDriftRows(db, project, opts.now - 2 * opts.windowMs),
	opts,
);
const alerts = classes.flatMap((c) => c.alerts);
const emitted =
	flag("--emit") === "true"
		? emitDriftAlerts(db, project, alerts, opts, (kind, scope, extra) =>
				emitStoredEvent(db, project, {
					kind,
					scope,
					source: "lane-drift",
					note: `drift ${extra.lane_class} ${extra.metric} ${extra.previous}→${extra.current}`,
					extra,
				}),
			)
		: [];
if (flag("--json") === "true")
	console.log(JSON.stringify({ project, ...opts, classes, emitted }, null, 2));
else {
	if (!classes.length) console.log("lane-drift: no samples in window");
	for (const c of classes) console.log(driftLine(c));
	if (emitted.length) console.log(`emitted lane.drift ${emitted.join(",")}`);
}
process.exit(alerts.length ? 1 : 0);
