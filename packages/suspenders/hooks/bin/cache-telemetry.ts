#!/usr/bin/env bun
// hooks/bin/cache-telemetry.ts — W825.2: weekly cache-telemetry mining
// runner (fleet-loop maintenance sweep, W779 pattern). Reads buckle's
// lane-cache NDJSON (W458.4), mines the weekly warm-cache report, and
// writes it where the W822 pulse digest reads it. Report-only: it never
// mutates the ledger, and missing telemetry mines an empty report (exit 0 —
// a maintenance task must not fail on absent data).
//
//   bun hooks/bin/cache-telemetry.ts [--json] [--window-days 7] [--log <path>] [--out <path>]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	cacheReportPath,
	defaultLaneCacheLog,
	mineCacheTelemetry,
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
	name: "cache-telemetry",
	usage:
		"usage: bun cache-telemetry.ts [--json] [--window-days N] [--log <path>] [--out <path>]",
	flags: ["--log", "--out", "--window-days"],
	switches: ["--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("cache-telemetry")(outcome.message || (SPEC.usage ?? ""));

const daysRaw = outcome.parsed.flag("--window-days");
const days = Math.max(1, Number(daysRaw ?? 7) || 7);
const json = outcome.parsed.flag("--json") === "true";

const logPath = outcome.parsed.flag("--log") ?? defaultLaneCacheLog();
const rows =
	logPath === null
		? []
		: rowsInWindow(readLaneCacheLog(logPath), Date.now() - days * 86_400_000);
const report = mineCacheTelemetry(rows);
const outPath = outcome.parsed.flag("--out") ?? cacheReportPath();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, "\t")}\n`);
if (json) console.log(JSON.stringify(report, null, 2));
console.log(
	`cache-telemetry: ${report.lanes.length} lane(s), ${report.offenders.length} offender(s), ${report.reuse.length} reuse cluster(s) → ${outPath}`,
);
