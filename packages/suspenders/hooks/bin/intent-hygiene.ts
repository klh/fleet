#!/usr/bin/env bun
// hooks/bin/intent-hygiene.ts — W2786 intent hygiene: the reconciliation
// sweep for lane_launch_intents. A REGISTERED intent whose pid is PROVABLY
// dead (inspectLaunchIntent === "dead" — process-table proof, never
// unknown) AND whose item's claim revision is older than 24h gets failed
// through the operator door's own machinery (failIntent: liveness-guarded,
// evidence-banked). Live lanes and unknown liveness are never touched —
// W51 (unknown never releases) is the law this sweep rides under.
//
//   bun hooks/bin/intent-hygiene.ts [--repo <dir>] [--min-age-h <n>] [--act] [--json]
//
// Dry-run is the default (monitor doctrine: the report is the product);
// --act performs the fails. Exit 1 when a dry-run finds candidates.
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import { openStore, projectIdentity } from "../lib/govdb/govdb.ts";
import {
	inspectLaunchIntent,
	launchSchema,
	type LaunchIntent,
} from "../../scripts/lib/launch-fencing.ts";
import { failIntent } from "../../scripts/lib/launch-intent-cli.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "intent-hygiene",
	usage:
		"usage: bun intent-hygiene.ts [--repo <dir>] [--min-age-h <n>] [--act] [--json]",
	flags: ["--repo", "--min-age-h"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("intent-hygiene")(outcome.message || (SPEC.usage ?? ""));
const act = outcome.parsed.flag("--act") === "true";
const json = outcome.parsed.flag("--json") === "true";
const repo = outcome.parsed.flag("--repo") ?? process.cwd();
const minAgeH = Number(outcome.parsed.flag("--min-age-h") ?? 24);

type Row = {
	item: string;
	sid: string;
	pid: number | null;
	ageH: number;
	verdict: string;
	action: "failed" | "kept";
	line: string;
};

const project = projectIdentity(repo);
const store = openStore();
const rows: Row[] = [];
try {
	launchSchema(store);
	const intents = (
		store.query(
			`SELECT * FROM lane_launch_intents WHERE project=? AND state='REGISTERED'`,
		) as unknown as { all: (...a: unknown[]) => LaunchIntent[] }
	).all(project);
	const now = Date.now();
	for (const intent of intents) {
		const verdict = inspectLaunchIntent(intent);
		const ageH = (now - intent.revision) / 3_600_000;
		const base = {
			item: intent.item,
			sid: intent.sid,
			pid: intent.pid,
			ageH: Math.round(ageH * 10) / 10,
			verdict,
		};
		// Only PROVEN-dead pids older than the floor fail; unknown/alive keep.
		if (verdict !== "dead" || ageH < minAgeH) {
			rows.push({
				...base,
				action: "kept",
				line: `kept (${verdict}, age ${Math.round(ageH * 10) / 10}h < ${minAgeH}h)`,
			});
			continue;
		}
		if (!act) {
			rows.push({
				...base,
				action: "kept",
				line: `candidate: dead pid, age ${Math.round(ageH * 10) / 10}h — rerun with --act`,
			});
			continue;
		}
		const failed = failIntent(
			store,
			project,
			intent.item,
			`W2786 intent-hygiene: pid ${String(intent.pid)} provably dead ${Math.round(ageH * 10) / 10}h after claim revision`,
		);
		rows.push({ ...base, action: "failed", line: failed.line });
	}
} finally {
	store.close();
}

const failed = rows.filter((r) => r.action === "failed");
if (act && failed.length)
	for (const r of failed)
		emitLoopEvent("dispatch.intent.failed", r.item, {
			project,
			sid: r.sid,
			by: "intent-hygiene",
		});

if (json) console.log(JSON.stringify({ project, act, minAgeH, rows }));
else {
	for (const r of rows)
		console.log(
			`${r.action === "failed" ? "FAILED" : "kept"}  ${r.item}  pid=${String(r.pid)}  ${r.line}`,
		);
	console.log(
		`${act ? "acted" : "dry-run"}: ${failed.length} failed, ${rows.length - failed.length} kept (min-age ${minAgeH}h)`,
	);
}
if (!act && rows.some((r) => r.line.startsWith("candidate"))) process.exit(1);
