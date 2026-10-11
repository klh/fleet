#!/usr/bin/env bun
// hooks/bin/copilot-usage.ts — CLI face of the copilot credit meter (W223.2).
//
//   bun hooks/bin/copilot-usage.ts [--fleet <dir>] [--store <db>] [--json] [--flush]
//
// Report-only by default: reads copilot's own session store read-only and
// prints per-lane credit totals (credits = SUM(request_multiplier), the
// premium-request billing dimension; nano_aiu and tokens as context).
// --flush stamps the totals into governor.db facts (`lane.<sid>.usage`,
// via the coord CLI verb — the supported surface) so `lanes` and the board
// surface them on the lane status path. Missing copilot store on this host
// is an honest no-op line, not an error. Exit 0 unless a flush write fails.
import { projectIdentity, projectRootOf } from "../lib/govdb.ts";
import {
	copilotStorePath,
	flushLaneUsageFacts,
	meterCopilotLanes,
} from "../../scripts/lib/copilot-meter.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "copilot-usage",
	usage:
		"usage: copilot-usage [--fleet <dir>] [--store <db>] [--json] [--flush]",
	flags: ["--fleet", "--store"],
	switches: ["--json", "--flush"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("copilot-usage")(outcome.message || (SPEC.usage ?? ""));
const p = outcome.parsed;
const flush = p.flag("--flush") === "true";
const json = p.flag("--json") === "true";
const fleet = p.flag("--fleet") ?? projectRootOf(projectIdentity());
const store = p.flag("--store") ?? copilotStorePath();

const report = meterCopilotLanes(fleet, { storeDb: store });
if (!report.ok) {
	if (json) console.log(JSON.stringify({ ok: false, why: report.why, store }));
	else
		console.log(
			`copilot meter: ${report.why} (${report.store}) — no copilot CLI usage data on this host`,
		);
	process.exit(0);
}

const stamped = flush ? flushLaneUsageFacts(report) : [];
const spent = report.lanes.filter((l) => l.sessions > 0);

if (json) {
	console.log(
		JSON.stringify(
			{ ok: true, store, flushed: stamped, lanes: report.lanes },
			null,
			2,
		),
	);
} else {
	if (spent.length === 0) {
		console.log("copilot meter: no attributed lane spend in the session store");
	} else {
		console.log("SID  ITEM  CREDITS  TOKENS  NANO_AIU  SESSIONS  MODELS");
		for (const l of spent)
			console.log(
				`${l.sid}  ${l.item}  ${Math.round(l.credits * 100) / 100}  ${Math.round(l.inTok + l.outTok + l.cacheR + l.cacheW)}  ${Math.round(l.nanoAiu)}  ${l.sessions}  ${[...new Set(l.models)].join(",") || "-"}`,
			);
	}
	if (flush)
		console.log(
			stamped.length > 0
				? `flushed ${stamped.length} lane usage fact(s): ${stamped.join(", ")}`
				: "flush: nothing to stamp (no attributed spend)",
		);
}
