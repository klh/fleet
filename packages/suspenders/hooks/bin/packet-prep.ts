#!/usr/bin/env bun
// hooks/bin/packet-prep.ts — W238 offline packet-prep CLI: compress
// architecture/operational prose at BUILD time, file pointers verbatim
// (W112 teeth in ../lib/packet-prep.ts). No server, no model, no db.
//
//   bun hooks/bin/packet-prep.ts <file...> [--json]   prep doc files
//   bun hooks/bin/packet-prep.ts --stdin [--json]     prep piped text
//   bun hooks/bin/packet-prep.ts --help
//
// Default: the compressed packet text to stdout (multi-file inputs are
// separated by a blank line) + a one-line metrics note to stderr.
// --json: one NDJSON line per input carrying the full PacketPrepResult
// (bytes, ratio, rules fired, pointers, lostPointers, degraded).
import { readFileSync } from "node:fs";
import { prepPacket } from "../lib/packet-prep.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "packet-prep",
	usage: "usage: packet-prep <file...> [--json] [--stdin]",
	switches: ["--json", "--stdin"],
});
const die = dieFor("packet-prep");

const main = (): number => {
	// kit-owned parse (W656.2) — the Bun strips-`--` reality is baked into
	// verb-kit; unknown options die before any file is read
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(renderVerbHelp(SPEC));
		return 0;
	}
	const outcome = parseVerb(SPEC, argv);
	if (!outcome.ok) die(outcome.message || (SPEC.usage ?? ""));
	const parsed = outcome.parsed;
	const json = parsed.flag("--json") === "true";
	const files = parsed.pos;
	const stdin = parsed.flag("--stdin") === "true";

	const inputs: { source: string; text: string }[] = [];
	for (const f of files) {
		try {
			inputs.push({ source: f, text: readFileSync(f, "utf8") });
		} catch (e) {
			console.error(
				`packet-prep: cannot read ${f}: ${e instanceof Error ? e.message : String(e)}`,
			);
			return 1;
		}
	}
	if (stdin) inputs.push({ source: "<stdin>", text: readFileSync(0, "utf8") });
	if (inputs.length === 0) die(SPEC.usage ?? "no inputs");

	for (const { source, text } of inputs) {
		const r = prepPacket(text);
		if (json) {
			console.log(JSON.stringify({ source, ...r }));
			continue;
		}
		process.stdout.write(inputs.length > 1 ? `${r.text}\n\n` : `${r.text}\n`);
		console.error(
			`[packet-prep] ${source}: ${r.inBytes}->${r.outBytes} bytes (ratio ${r.ratio.toFixed(2)}, rules ${r.rules.length}, pointers ${r.pointers.length}${r.degraded ? ", DEGRADED — pointer loss refused" : ""})`,
		);
	}
	return 0;
};

process.exit(main());
