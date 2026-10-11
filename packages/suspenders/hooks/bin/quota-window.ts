#!/usr/bin/env bun
// hooks/bin/quota-window.ts — W657 thin face: the verdict library is
// hooks/lib/quota-window.ts (quotaWindowVerdict/harvestResets); this face
// owns argv, the note verb, output lines and the 0/1/2 exit contract.
//   bun hooks/bin/quota-window.ts [note "reset at YYYY-MM-DD HH:MM:SS"] [--margin minutes]
import { quotaWindowVerdict } from "../lib/quota-window.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

if (import.meta.main) {
	const outcome = parseVerb(
		defineVerb({
			name: "quota-window",
			usage:
				'bun hooks/bin/quota-window.ts [note "reset at YYYY-MM-DD HH:MM:SS"] [--margin minutes]',
			flags: ["--margin"],
			lax: true,
		}),
		process.argv.slice(2),
	);
	if (!outcome.ok) {
		console.error(
			outcome.message ||
				'bun hooks/bin/quota-window.ts [note "reset at ..."] [--margin minutes]',
		);
		process.exit(2);
	}
	const { pos } = outcome.parsed;
	// manual observations survive log rotation: quota-window note "reset at <time>"
	const noteReset: number[] = [];
	if (pos[0] === "note") {
		const m = pos
			.slice(1)
			.join(" ")
			.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
		if (m)
			noteReset.push(new Date(`${m[1].replace(" ", "T")}+00:00`).getTime());
	}
	const margin = Number(outcome.parsed.flag("--margin") ?? 45) * 60_000;
	const v = quotaWindowVerdict({ marginMs: margin, extraResets: noteReset });
	for (const l of v.lines) console.log(l);
	process.exit(v.code);
}
