#!/usr/bin/env bun
// hooks/bin/signals-scan.ts — W969 Signals-lite CLI face (hooks/lib/
// signals-scan.ts is the logic): one fire of the per-run silent-failure
// scan of closed lanes via the pinned oracle leg (:8903 default). The
// fleet-loop maintenance registry (W779) fires it every 10 min with
// --repo; SUSPENDERS_SIGNALS_SCAN=0 disables; exit 0 always — the scan
// never blocks lane close (skips and holds are the report's business).
//   bun hooks/bin/signals-scan.ts [--repo <dir>] [--limit <n>]
//        [--state <file>] [--json]
import { join } from "node:path";
import { openStore } from "../lib/govdb.ts";
import { createSignalsScan } from "../lib/signals-scan.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "signals-scan",
	usage:
		"usage: bun signals-scan.ts [--repo <dir>] [--limit <n>] [--state <file>] [--json]",
	flags: ["--repo", "--limit", "--state"],
	switches: ["--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok) dieFor("signals-scan")(outcome.message || (SPEC.usage ?? ""));

if (process.env.SUSPENDERS_SIGNALS_SCAN === "0") {
	console.log("signals-scan: disabled (SUSPENDERS_SIGNALS_SCAN=0)");
	process.exit(0);
}

const val = (flag: string): string | undefined =>
	outcome.parsed.flag(flag) ?? undefined;
const repo = val("--repo") ?? process.cwd();
const limit = Number(val("--limit") ?? 8) || 8;
const statePath = val("--state") ?? join(repo, ".fleet", "signals-scan.json");

const scan = createSignalsScan({
	repo,
	store: openStore(),
	statePath,
	limit,
	log: (m) => console.log(m),
});
const r = await scan();
if (outcome.parsed.flag("--json") === "true") console.log(JSON.stringify(r));
else
	console.log(
		`signals-scan: scanned ${r.scanned.length} · findings ${r.blamQueued} · held ${r.held} · skipped ${r.skipped}`,
	);
