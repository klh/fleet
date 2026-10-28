#!/usr/bin/env bun
// hooks/bin/model-health-sweep.ts — CLI face of the W2194 hub model-health
// sweep (the fleet-loop maintenance task "model-health-sweep" rides this).
//
//   bun hooks/bin/model-health-sweep.ts [--json]
//
// Every configured hub (stack.json profiles) + the local Mac spoke probes
// each catalog group through ITS OWN buckle front (tiny max_tokens call),
// banks model.health.<core> facts, exits 1 when any group is DOWN (report
// convention: exit 1 = down groups present, the heartbeat notices).
// SUSPENDERS_MODEL_HEALTH=0 disables (the heartbeat skips via exit 0).
import { openStore } from "../lib/govdb/govdb.ts";
import { sweepOnce } from "../lib/hub/model-health.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "model-health-sweep",
	usage: "usage: bun model-health-sweep.ts [--json]",
	switches: ["--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("model-health-sweep")(outcome.message || (SPEC.usage ?? ""));
const parsed = outcome.ok ? outcome.parsed : process.exit(1);
const json = parsed.flag("--json") === "true";

if (process.env.SUSPENDERS_MODEL_HEALTH === "0") {
	console.log("model-health-sweep: disabled (SUSPENDERS_MODEL_HEALTH=0)");
	process.exit(0);
}

const store = openStore();
try {
	const summary = await sweepOnce({ store });
	if (json) {
		console.log(JSON.stringify(summary));
	} else {
		for (const h of summary.hubs) {
			console.log(
				`model-health-sweep: ${h.hub} catalog=${h.catalogUp ? "up" : "absent"} groups=${h.groups}`,
			);
		}
		console.log(
			summary.down.length === 0
				? "model-health-sweep: all probed groups up"
				: `model-health-sweep: DOWN — ${summary.down.join(", ")}`,
		);
	}
	process.exit(summary.down.length > 0 ? 1 : 0);
} finally {
	store.close();
}
