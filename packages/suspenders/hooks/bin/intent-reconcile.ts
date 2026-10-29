#!/usr/bin/env bun
// hooks/bin/intent-reconcile.ts — CLI face of the W2262 stale launch-intent
// reconcile (scripts/lib/intent-reconcile.ts). Fails lane_launch_intents rows
// whose work item is TERMINAL (DONE/SUPERSEDED/CANCELLED/FAILED) and whose
// process verdict is not alive — the 2026-10-29 incident: ten REGISTERED
// unknown-liveness rows for DONE items held phantom slots and refused urgent
// dispatch at 7/8. Never touches a live lane; never touches a nonterminal
// item (claim ambiguity belongs to the reclaim liveness path). Dry-run is
// the default; the fleet-loop heartbeat fires it with --act. Exit 2 when the
// governor store is unavailable (fail-closed: no store = no flips, protects
// live lanes).
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
import { canonicalProjectRoot } from "../lib/lanes/lane-registry.ts";
import { inspectLaunchIntent } from "../../scripts/lib/launch-fencing.ts";
import {
	reconcileTerminalLaunchIntents,
	type ReconcileReport,
} from "../../scripts/lib/intent-reconcile.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "intent-reconcile",
	usage:
		"usage: bun intent-reconcile.ts [--act] [--json] [--repo <dir>]",
	flags: ["--repo"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("intent-reconcile")(outcome.message || (SPEC.usage ?? ""));
const act = outcome.parsed.flag("--act") === "true";
const json = outcome.parsed.flag("--json") === "true";
const repo = outcome.parsed.flag("--repo") ?? process.cwd();
const project = projectIdentity(canonicalProjectRoot(repo));

let store: ReturnType<typeof openStore> | null = null;
try {
	store = openStore();
} catch {
	store = null;
}
if (store === null) {
	console.error(
		"intent-reconcile: governor store unavailable — refusing to fail intents (fail-closed keep)",
	);
	process.exit(2);
}

const report: ReconcileReport = reconcileTerminalLaunchIntents({
	store,
	project,
	act,
	inspect: inspectLaunchIntent,
});

if (act && report.failed.length > 0) {
	// one plane-level summary; the per-row immutable audits
	// (dispatch.intent.stale-failed) were already written by the lib
	try {
		store
			.query(
				"INSERT INTO events(ts,source,kind,scope,payload,target) VALUES (?,?,?,?,?,?)",
			)
			.run(
				Date.now(),
				"intent-reconcile",
				"plane.intentreconcile",
				"plane",
				JSON.stringify({
					failed: report.failed.length,
					live: report.skippedLive,
					ambiguous: report.skippedAmbiguous,
					scanned: report.scanned,
					errors: report.failures.length,
					items: report.failed.map((r) => r.item),
				}),
				null,
			);
	} catch {}
}

if (json) {
	console.log(JSON.stringify({ act, ...report }, null, 2));
} else {
	for (const row of report.failed)
		console.log(
			`${act ? "" : "would "}fail intent ${row.item} (state ${row.priorState}, ${row.liveness})`,
		);
	for (const err of report.failures) console.error(err);
	console.log(
		`${report.scanned} intent row(s): failed ${report.failed.length}, live-kept ${report.skippedLive}, ambiguous-kept ${report.skippedAmbiguous}, errors ${report.failures.length}` +
			(act ? " · acted" : " · dry-run"),
	);
}
store.close();
process.exit(0);
