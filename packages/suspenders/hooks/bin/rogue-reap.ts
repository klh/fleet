#!/usr/bin/env bun
// hooks/bin/rogue-reap.ts — CLI face of the W827 rogue-serve reaper
// (hooks/lib/rogue-reap.ts). Kills serve processes (buckle server,
// fleet-board, router-shim, dashboard, coord store) running from fleet
// worktree or fleet-ish tmp copies no live lane claim covers — cwd OR
// commandline scope (W973 reap-by-commandline), and prunes merged-and-
// clean stale worktrees. Kill batch bounded (--max-kill, default 200).
//
//   bun hooks/bin/rogue-reap.ts [--act] [--json] [--repo <dir>]
//        [--main <branch>] [--grace-ms <n>] [--max-kill <n>]
//
// Dry-run is the default (monitor doctrine: alerts first) — the report is
// the product; --act performs the reaps + prune. The fleet-loop maintenance
// registry (W779) fires it with --act every 30 min. Act runs with reaped
// or surviving serves emit a plane.rogue event carrying the counts (W973).
// `.fleet/rogue-reap-paused` pauses everything. Exit 1 when a dry-run
// finds candidates or prune rows (a cron or a human should notice).
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import { openStore, projectIdentity } from "../lib/govdb.ts";
import type { LaneRef } from "../lib/lane-liveness.ts";
import { readLaneRegistry } from "../lib/lane-registry.ts";
import { createRogueReap, type ReapReport } from "../lib/rogue-reap.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "rogue-reap",
	usage:
		"usage: bun rogue-reap.ts [--act] [--json] [--repo <dir>] [--main <branch>] [--grace-ms <n>] [--max-kill <n>]",
	flags: ["--repo", "--main", "--grace-ms", "--max-kill"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("rogue-reap")(outcome.message || (SPEC.usage ?? ""));
const act = outcome.parsed.flag("--act") === "true";
const json = outcome.parsed.flag("--json") === "true";
const val = (flag: string): string | undefined =>
	outcome.parsed.flag(flag) ?? undefined;

const repo = val("--repo") ?? process.cwd();
const main = val("--main") ?? "main";
const graceMs = Number(val("--grace-ms") ?? 120_000);
const maxKillArg = Number(val("--max-kill") ?? NaN);
const maxKill =
	Number.isFinite(maxKillArg) && maxKillArg > 0 ? maxKillArg : undefined;

const registry = readLaneRegistry<LaneRef & { branch?: string }>(repo);
const lanes = (): LaneRef[] => (registry.known ? registry.lanes : []);

let store: ReturnType<typeof openStore> | null = null;
try {
	store = openStore();
} catch {
	// pre-graph or locked db — no claim term at all
}
const claimState = (item: string): string | null => {
	// throws on db/identity failure — the bin catches and exits fail-closed
	const row = store
		?.query("SELECT state FROM work_items WHERE project = ? AND id = ?")
		.get(projectIdentity(repo), item) as { state: string } | undefined;
	return row?.state ?? null;
};

const reap = createRogueReap({
	repo,
	main,
	act,
	graceMs: Number.isFinite(graceMs) ? graceMs : 120_000,
	maxKill,
	lanes,
	claimState,
	log: (msg: string): void => {
		console.log(msg);
	},
});
let report: ReapReport;
try {
	report = reap.reap();
} catch (e) {
	// fail-closed: a claim-term error never lets the fire proceed to kills
	console.error(
		`rogue-reap failed: ${e instanceof Error ? e.message : String(e)}`,
	);
	process.exit(2);
}

// W973: act runs with anything reaped or surviving report to the plane —
// the counts are the cap's receipt (re-check = absence of a new event)
if (
	act &&
	!report.paused &&
	store !== null &&
	report.reaped + report.survivors > 0
) {
	emitLoopEvent(
		"plane.rogue",
		"plane",
		{
			reaped: report.reaped,
			survivors: report.survivors,
			pids: report.candidates.map((c) => c.pid),
		},
		store,
	);
}

if (json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	for (const c of report.candidates)
		console.log(
			`${report.dryRun ? "would " : ""}reap pid=${c.pid} sig=${c.sig} ${c.worktree}`,
		);
	for (const p of report.pruned)
		console.log(
			`${report.dryRun ? "would " : ""}${p.action} ${p.branch} ${p.worktree} — ${p.why}`,
		);
	console.log(
		`${report.candidates.length} rogue serve(s), reaped ${report.reaped}, survivors ${report.survivors}, ${report.pruned.length} prune row(s)` +
			(report.paused ? " · PAUSED" : report.dryRun ? " · dry-run" : " · acted"),
	);
}
store?.close?.();
const attention =
	report.candidates.length > 0 || report.pruned.length > 0 ? 1 : 0;
process.exit(!act && attention ? 1 : 0);
