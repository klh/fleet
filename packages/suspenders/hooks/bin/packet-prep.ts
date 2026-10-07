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

const USAGE = `usage: packet-prep.ts <file...> [--json] | --stdin [--json] | --help`;

const main = (): number => {
	// Bun strips `--` before argv (lesson: bun-swallows-double-dash) —
	// positionals come from argv[2:] verbatim, flags matched exactly.
	const args = process.argv.slice(2);
	if (args.length === 0 || args.includes("--help")) {
		console.error(USAGE);
		return args.includes("--help") ? 0 : 1;
	}
	const json = args.includes("--json");
	const files = args.filter((a: string) => !a.startsWith("--"));
	const stdin = args.includes("--stdin");

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
	if (inputs.length === 0) {
		console.error(USAGE);
		return 1;
	}

	for (const { source, text } of inputs) {
		const r = prepPacket(text);
		if (json) {
			console.log(JSON.stringify({ source, ...r }));
			continue;
		}
		process.stdout.write(
			inputs.length > 1 ? `${r.text}\n\n` : `${r.text}\n`,
		);
		console.error(
			`[packet-prep] ${source}: ${r.inBytes}->${r.outBytes} bytes (ratio ${r.ratio.toFixed(2)}, rules ${r.rules.length}, pointers ${r.pointers.length}${r.degraded ? ", DEGRADED — pointer loss refused" : ""})`,
		);
	}
	return 0;
};

process.exit(main());
