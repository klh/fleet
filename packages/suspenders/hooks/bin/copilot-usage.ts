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
import { projectIdentity } from "../lib/govdb.ts";
import {
	copilotStorePath,
	flushLaneUsageFacts,
	meterCopilotLanes,
} from "../../scripts/lib/copilot-meter.ts";

const argv = process.argv.slice(2);
const val = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const flush = argv.includes("--flush");
const json = argv.includes("--json");
const fleet =
	val("--fleet") ??
	(() => {
		const pi = projectIdentity();
		return pi.endsWith("/.git") ? pi.slice(0, -"/.git".length) : pi;
	})();
const store = val("--store") ?? copilotStorePath();

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
