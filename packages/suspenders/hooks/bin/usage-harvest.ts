#!/usr/bin/env bun
// hooks/bin/usage-harvest.ts — W657 thin face: the collector library is
// hooks/lib/usage/usage-harvest.ts (adapter + engine pipeline + the ONE TTL gate,
// maybeHarvest). This entry is argv → lib only. w159: govdb opens LAZILY
// inside main — a top-level bind would poison shared-module suites.
//   bun hooks/bin/usage-harvest.ts [--force]
// Prints the harvest stats JSON ({skipped:"ttl-fresh"} when gated out).
import { maybeHarvest } from "../lib/usage/usage-harvest.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

if (import.meta.main) {
	const outcome = parseVerb(
		defineVerb({
			name: "usage-harvest",
			usage: "bun hooks/bin/usage-harvest.ts [--force]",
			switches: ["--force"],
			lax: true,
		}),
		process.argv.slice(2),
	);
	if (!outcome.ok) {
		console.error(
			outcome.message || "bun hooks/bin/usage-harvest.ts [--force]",
		);
		process.exit(2);
	}
	// CLI-only, lazy: the library must not bind an un-busted govdb module
	// entry at import time (shared with un-busted consumers like settle.ts).
	const { openStore } = await import("../lib/govdb/govdb.ts");
	const db = openStore();
	const force = outcome.parsed.rest.includes("--force");
	const s = maybeHarvest(db, force ? 0 : undefined);
	console.log(JSON.stringify(s ?? { skipped: "ttl-fresh" }));
}
