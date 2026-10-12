#!/usr/bin/env bun
// hooks/bin/usage-seed.ts — W657 thin face: the seed library is
// hooks/lib/usage-seed.ts. w159: govdb opens LAZILY inside main.
//   bun hooks/bin/usage-seed.ts [--purge]
// Prints the seed/purge stats JSON.
import { purgeUsage, seedUsage } from "../lib/usage-seed.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

if (import.meta.main) {
	const outcome = parseVerb(
		defineVerb({
			name: "usage-seed",
			usage: "bun hooks/bin/usage-seed.ts [--purge]",
			switches: ["--purge"],
			lax: true,
		}),
		process.argv.slice(2),
	);
	if (!outcome.ok) {
		console.error(outcome.message || "bun hooks/bin/usage-seed.ts [--purge]");
		process.exit(2);
	}
	const { openStore } = await import("../lib/govdb.ts");
	const db = openStore();
	console.log(
		JSON.stringify(
			outcome.parsed.rest.includes("--purge") ? purgeUsage(db) : seedUsage(db),
		),
	);
}
