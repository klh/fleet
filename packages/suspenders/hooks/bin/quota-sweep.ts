#!/usr/bin/env bun
// hooks/bin/quota-sweep.ts — CLI face of the quota-exhaustion sweep (W366).
//
//   bun hooks/bin/quota-sweep.ts [--act] [--json] [--sid <sid>]
//        [--lookback-min 90] [--buckle-db <path>]
//
// Report-only by default (monitor doctrine: alerts first); --act performs
// the fleet pickup — reclaim the dead sid's claims via `work reclaim`,
// emit `quota.exhausted` on the bus, broadcast one note. monitor.ts --fix
// runs the same sweep in-process every 15 min. Exit 1 when an exhausted
// verdict is reported without --act (a cron or a human should notice).
import { openGovernorDb } from "../lib/govdb.ts";
import { quotaSweep } from "../lib/quota-sweep.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "quota-sweep",
	usage:
		"usage: bun quota-sweep.ts [--act] [--json] [--sid <sid>] [--lookback-min 90] [--buckle-db <path>]",
	flags: ["--sid", "--lookback-min", "--buckle-db"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("quota-sweep")(outcome.message || (SPEC.usage ?? ""));
const act = outcome.parsed.flag("--act") === "true";
const json = outcome.parsed.flag("--json") === "true";
const val = (flag: string): string | undefined =>
	outcome.parsed.flag(flag) ?? undefined;

const db = openGovernorDb();
// sids holding an OPEN decision stay claimed even when dead (paired-lane
// finding folded W366): re-dispatching under a dangling fork strands it
const waitingSids = new Set<string>();
try {
	for (const r of db
		.query(
			"SELECT DISTINCT answer_to AS sid FROM decisions WHERE state = 'OPEN' AND answer_to IS NOT NULL",
		)
		.all() as { sid: string }[])
		waitingSids.add(r.sid);
} catch {} // pre-decisions db — nothing to exempt

const report = await quotaSweep({
	db,
	act,
	waitingSids,
	sid: val("--sid"),
	buckleDb: val("--buckle-db"),
	lookbackMs: Number(val("--lookback-min") ?? 90) * 60_000,
});

if (json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	for (const v of report.verdicts) {
		if (v.exhausted) {
			console.log(
				`× ${v.sid} ${v.note} — claims ${v.claims.map((c) => c.id).join(",") || "none"}`,
			);
		} else if (v.hits.length > 0) {
			console.log(`~ ${v.sid} ${v.note}`);
		}
	}
	for (const a of report.actions)
		console.log(`✓ ${a.kind} ${a.sid ? `${a.sid} ` : ""}${a.detail}`);
	const exhausted = report.verdicts.filter((v) => v.exhausted).length;
	console.log(
		`${report.verdicts.length} claimant sid(s) scanned, ${exhausted} quota-exhausted` +
			(report.auditDb
				? ` · route_audit: ${report.auditUnattributed} unattributed 429/quota row(s) in window`
				: " · route_audit: source unavailable"),
	);
}
process.exit(!act && report.verdicts.some((v) => v.exhausted) ? 1 : 0);
