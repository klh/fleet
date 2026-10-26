#!/usr/bin/env bun
// hooks/bin/cache-sla.ts — W1139.1: the rolling per-lane cache hit-share SLA
// sweep runner (fleet-loop maintenance, W779 pattern). Reads buckle's W458.4
// lane-cache NDJSON, computes per-lane rolling hit shares over the window,
// writes the status JSON the board face (/api/usage/cache-sla) + badge read,
// and exits 1 when a lane breached (metrics-alert exit convention: a fail
// log in the heartbeat, never a crash). Missing telemetry = an empty nodata
// report, exit 0 — a maintenance task must not fail on absent data.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	cacheSlaBadge,
	cacheSlaStatusPath,
	evaluateCacheSla,
} from "../lib/usage/cache-sla.ts";
import {
	defaultLaneCacheLog,
	readLaneCacheLog,
	rowsInWindow,
} from "../lib/usage/cache-telemetry.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "cache-sla",
	usage:
		"usage: bun cache-sla.ts [--json] [--window-min N] [--threshold F] [--min-requests N] [--log <path>] [--out <path>]",
	flags: ["--window-min", "--threshold", "--min-requests", "--log", "--out"],
	switches: ["--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("cache-sla")(outcome.message || (SPEC.usage ?? ""));

const windowMin = Math.max(
	1,
	Number(outcome.parsed.flag("--window-min") ?? 60) || 60,
);
const threshold = clamp01(Number(outcome.parsed.flag("--threshold") ?? 0.5));
const minRequests = Math.max(
	1,
	Number(outcome.parsed.flag("--min-requests") ?? 5) || 5,
);
const json = outcome.parsed.flag("--json") === "true";

const logPath = outcome.parsed.flag("--log") ?? defaultLaneCacheLog();
const rows =
	logPath === null
		? []
		: rowsInWindow(readLaneCacheLog(logPath), Date.now() - windowMin * 60_000);
const report = evaluateCacheSla(rows, {
	windowMinutes: windowMin,
	threshold,
	minRequests,
});
const outPath = outcome.parsed.flag("--out") ?? cacheSlaStatusPath();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, "\t")}\n`);
if (json) console.log(JSON.stringify(report, null, 2));
const badge = cacheSlaBadge(report);
console.log(
	`cache-sla: ${badge.text} (${String(report.lanes.length)} lane(s) in window) → ${outPath}`,
);
if (report.breaches.length > 0) process.exit(1);

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0.5;
	return Math.min(1, Math.max(0, n));
}

