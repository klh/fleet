#!/usr/bin/env bun
// hooks/bin/ghost-sweep.ts — CLI face of the W2842 ghost sweep
// (hooks/lib/lanes/ghost-sweep.ts). Flips heartbeat-dead RUNNING sessions —
// no live process, no live claim/decision guards — to the terminal
// GHOSTED state, bounded batch per fire. Dry-run is the default (monitor
// doctrine: the output IS the report; --act performs the transitions
// + emits one session.ghosted event per flip. The fleet-loop maintenance
// registry (W779) fires it with --act every 30 min.
//
//   bun hooks/bin/ghost-sweep.ts [--act] [--json] [--repo <dir>]
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import { ghostSweep, type GhostDecision } from "../lib/lanes/ghost-sweep.ts";
import { openStore } from "../lib/govdb/govdb.ts";
import type { LaneRef } from "../lib/lanes/lane-liveness.ts";
import { readLaneRegistry } from "../lib/lanes/lane-registry.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "ghost-sweep",
	usage: "usage: bun ghost-sweep.ts [--act] [--json] [--repo <dir>]",
	flags: ["--repo"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("ghost-sweep")(outcome.message || (SPEC.usage ?? ""));
const act = outcome.parsed.flag("--act") === "true";
const json = outcome.parsed.flag("--json") === "true";
const repo = outcome.parsed.flag("--repo") ?? process.cwd();

const registry = readLaneRegistry<LaneRef>(repo);
const lanes = new Map<string, LaneRef>(
	registry.known ? registry.lanes.map((l) => [l.sid, l]) : [],
);

let store: ReturnType<typeof openStore> | null = null;
try {
	store = openStore();
} catch {
	// pre-graph or locked db — nothing to sweep
}

const rows: GhostDecision[] = store
	? ghostSweep(store, { registryDir: repo, act, registry: lanes })
	: [];
const ghosted = rows.filter((r) => r.action === "ghosted");
if (json) {
	console.log(JSON.stringify({ act, ghosted: ghosted.length, rows }));
} else {
	for (const r of rows) console.log(`${r.action} ${r.sid} — ${r.why}`);
	console.log(
		`ghost-sweep${act ? "" : " (dry-run)"}: ${ghosted.length} ghosted of ${rows.length} examined`,
	);
}
if (act && store !== null && ghosted.length > 0)
	emitLoopEvent("session.ghosted", "plane", { ghosted: ghosted.length });
store?.close();
