#!/usr/bin/env bun
// hooks/bin/aid-harvest.ts — W657 thin face: the pull library is
// hooks/lib/aid-harvest.ts. w159: govdb opens LAZILY inside main.
//   bun hooks/bin/aid-harvest.ts [--base http://127.0.0.1:4101]
// Prints the pull stats JSON; buckle down = honest skip row, exit 0.
import { harvestAids } from "../lib/aid-harvest.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

if (import.meta.main) {
	const outcome = parseVerb(
		defineVerb({
			name: "aid-harvest",
			usage: "bun hooks/bin/aid-harvest.ts [--base URL]",
			flags: ["--base"],
			lax: true,
		}),
		process.argv.slice(2),
	);
	if (!outcome.ok) {
		console.error(
			outcome.message || "bun hooks/bin/aid-harvest.ts [--base URL]",
		);
		process.exit(2);
	}
	const { openGovernorDb } = await import("../lib/govdb.ts");
	const stats = await harvestAids(openGovernorDb(), {
		baseUrl: outcome.parsed.flag("--base") ?? undefined,
	});
	console.log(JSON.stringify(stats));
}
