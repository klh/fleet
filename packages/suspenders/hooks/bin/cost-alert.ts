#!/usr/bin/env bun
// hooks/bin/cost-alert.ts — CLI face of the W1132 cost sweep.
//
//   bun hooks/bin/cost-alert.ts [--act] [--json] [--buckle-db <path>]
//        [--notify-conf <path>]
//
// Evaluates the three alert rules (budget 50/80/95, hourly > 3x the 7d MA,
// one call > 10x the median) over the buckle ledger's PRICED rows. Budgets
// come from notify.json `cost:` (machine conf — no budget conf, no budget
// rule). Report-only by default: exit 1 = alerts present (a cron notices).
// --act lands one `cost.alert` bus event per alert and exits 0 (the
// quota-sweep convention — the sweep acted, it didn't fail).
import { openStore } from "../lib/govdb/govdb.ts";
import {
	costSweepInputs,
	evaluateCostAlerts,
	loadCostConf,
	renderCostAlert,
} from "../lib/notify/cost-alerts.ts";
import { resolveBuckleDb } from "../lib/lanes/lane-spend.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "cost-alert",
	usage:
		"usage: bun cost-alert.ts [--act] [--json] [--buckle-db <path>] [--notify-conf <path>]",
	flags: ["--buckle-db", "--notify-conf"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("cost-alert")(outcome.message || (SPEC.usage ?? ""));
const parsed = outcome.ok ? outcome.parsed : process.exit(1);
const act = parsed.flag("--act") === "true";
const json = parsed.flag("--json") === "true";
const val = (flag: string): string | undefined =>
	parsed.flag(flag) ?? undefined;

const dbPath = val("--buckle-db") ?? resolveBuckleDb();
if (!dbPath) {
	console.log(
		json
			? '{"alerts":[],"note":"no buckle ledger"}'
			: "cost-alert: no buckle ledger — nothing to sweep",
	);
	process.exit(2);
}
const { hours, calls } = costSweepInputs(dbPath);
const alerts = evaluateCostAlerts({
	hours,
	calls,
	conf: loadCostConf(val("--notify-conf")),
});

if (json) {
	console.log(JSON.stringify({ alerts }));
} else if (alerts.length === 0) {
	console.log("cost-alert: sweep clean — no alerts");
} else {
	for (const a of alerts) console.log(renderCostAlert(a));
}
if (act && alerts.length > 0) {
	try {
		const db = openStore();
		const now = Date.now();
		for (const a of alerts) {
			db.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'cost-alert', 'cost.alert', ?, ?, NULL)",
			).run(now, a.key, JSON.stringify(a));
		}
		db.close();
	} catch {
		// bus down — the printed alerts still stand, exit code unchanged
	}
}
// report mode: exit 1 = alerts present; act mode: the sweep acted → 0
process.exit(!act && alerts.length > 0 ? 1 : 0);
