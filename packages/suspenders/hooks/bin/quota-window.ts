#!/usr/bin/env bun
// hooks/bin/quota-window.ts — W657 thin face: the verdict library is
// hooks/lib/usage/quota-window.ts (quotaWindowVerdict/harvestResets); this face
// owns argv, the status/note verbs, output lines and the 0/1/2 exit contract.
//   bun hooks/bin/quota-window.ts              # status; exit 0 safe / 1 near cliff / 2 unknown
//   bun hooks/bin/quota-window.ts --margin 45
//   bun hooks/bin/quota-window.ts note "reset at YYYY-MM-DD HH:MM:SS"
//
// W672 integration: main's W656.2 verb-kit CLI layer (status default + note
// verb, registry --help, dieFor) over W657's thin face; the engine lives in
// hooks/lib/usage/quota-window.ts.
import { quotaWindowVerdict } from "../lib/usage/quota-window.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderRegistryHelp,
} from "../lib/verb-kit.ts";

if (import.meta.main) {
	// W656.2 kit layer: bare invocation stays STATUS (the launchd / ad-hoc
	// default), `note <text>` is the second verb; --help renders from the registry
	const die = dieFor("quota-window");
	const STATUS = defineVerb({
		name: "status",
		usage:
			"usage: quota-window [status] [--margin <minutes>] — exit 0 safe / 1 near cliff / 2 unknown",
		flags: ["--margin"],
	});
	const NOTE_SPEC = defineVerb({
		name: "note",
		usage: 'usage: quota-window note "reset at YYYY-MM-DD HH:MM:SS"',
		minPos: 1,
	});
	const argv = process.argv.slice(2);
	if (argv[0] === "--help" || argv[0] === "-h") {
		console.log(
			renderRegistryHelp(
				"quota-window",
				"quota-window — z.ai/GLM 5-hour window tracker.",
				[STATUS, NOTE_SPEC],
			),
		);
		process.exit(0);
	}
	const note = argv[0] === "note";
	const spec = note ? NOTE_SPEC : STATUS;
	const rest = note || argv[0] === "status" ? argv.slice(1) : argv;
	const outcome = parseVerb(spec, rest);
	if (!outcome.ok) die(outcome.message || (spec.usage ?? ""));
	const { pos } = outcome.parsed;
	// manual observations survive log rotation: quota-window.ts note "reset at <time>"
	const noteReset: number[] = [];
	if (note) {
		const m = pos.join(" ").match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
		if (m)
			noteReset.push(new Date(`${m[1].replace(" ", "T")}+00:00`).getTime());
	}
	const margin = Number(outcome.parsed.flag("--margin") ?? 45) * 60_000;
	const v = quotaWindowVerdict({ marginMs: margin, extraResets: noteReset });
	for (const l of v.lines) console.log(l);
	process.exit(v.code);
}
