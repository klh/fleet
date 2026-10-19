// W552.8: the W552 export preflight — reads the owner GO (bus event #46573
// or the 0600 go-owner seal) and proceeds to the caption export when the
// evidence AND the raw take exist; otherwise reports exactly what is still
// pending. Before this gate the parent lane closed every attempt with
// "Nothing new - parent operator-gated" because the mechanism never read
// the bus.
//
// Usage:
//   bun scripts/w552-8-export-preflight.ts                      — gate + readiness report
//   bun scripts/w552-8-export-preflight.ts --raw <mp4> --cues <json> --out <dir>
//                                                               — run the export on GO
// Env: FLEET_DEMO_KIT (kit dir; default = the fleet main checkout's
// .fleet/demos/ikea-recording), CAPTION_EXPORT_PYTHON (default python3).
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	goEventFromScan,
	modeIs0600,
	parseGoSeal,
	sealFromEvent,
} from "./lib/export-go-gate.ts";

// argv fallback per the Bun strips-`--` reality; simple --flag value loop.
const args = process.argv.slice(2);
const flag = (name: string): string | null => {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const coordCli =
	process.env.SUSPENDERS_COORD_CLI ??
	join(import.meta.dir, "../hooks/bin/coord.ts");
const kit =
	process.env.FLEET_DEMO_KIT ??
	"/Volumes/Sensitive/github/klh/fleet/.fleet/demos/ikea-recording";
const sealPath = join(kit, "go-owner");
const exporter = join(kit, "capture/caption-export.py");

/** The bus face of the gate: a coord events scan through the sanctioned CLI. */
const busGoEvent = (): ReturnType<typeof goEventFromScan> => {
	const run = spawnSync(
		"bun",
		[coordCli, "events", "--kinds", "BROADCAST", "--last", "400", "--json"],
		{
			env: process.env,
			encoding: "utf8",
		},
	);
	if (run.status !== 0) {
		console.log(`bus scan failed (exit ${run.status}): ${run.stderr.trim()}`);
		return null;
	}
	try {
		return goEventFromScan(JSON.parse(run.stdout));
	} catch {
		console.log("bus scan produced unparseable JSON");
		return null;
	}
};

const pending: string[] = [];
const gate = (): string | null => {
	// 1. the 0600 seal — durable evidence written at GO time.
	if (existsSync(sealPath)) {
		const mode = statSync(sealPath).mode & 0o777;
		const seal = parseGoSeal(readFileSync(sealPath, "utf8"));
		if (modeIs0600(mode) && seal) {
			console.log(`GO via seal ${sealPath} (event #${seal.event})`);
			return "seal";
		}
		pending.push(
			`seal ${sealPath} present but not valid 0600 OWNER-GO JSON — ignored`,
		);
	}
	// 2. the bus — the live owner-GO broadcast.
	const ev = busGoEvent();
	if (ev) {
		console.log(`GO via bus event #${ev.id}: ${ev.note.split(". ")[0]}`);
		if (!existsSync(sealPath)) {
			mkdirSync(kit, { recursive: true, mode: 0o700 });
			writeFileSync(
				sealPath,
				`${JSON.stringify(sealFromEvent(ev), null, 2)}\n`,
				{ mode: 0o600 },
			);
			console.log(`sealed ${sealPath} (0600) from event #${ev.id}`);
		}
		return "bus";
	}
	return null;
};

const go = gate();
if (!go) {
	for (const p of pending) console.log(`WARN ${p}`);
	console.log(
		"OPERATOR-GATED: no owner-GO evidence (seal + bus both empty) — export stays closed",
	);
	process.exit(1);
}
for (const p of pending) console.log(`WARN ${p}`);

// GO present — proceed to the export when the raw take exists.
const raw = flag("--raw");
const cues = flag("--cues");
const out = flag("--out");
if (!raw || !cues || !out) {
	console.log(
		"GO present; export ready to run — supply --raw <mp4> --cues <json> --out <dir> (raw Screen Studio export stays outside capture/, unmodified). Raw capture is still operator work when no footage exists yet.",
	);
	process.exit(0);
}
if (!existsSync(raw) || !existsSync(cues)) {
	console.log(
		`GO present; export inputs missing: ${[raw, cues].filter((f) => !existsSync(f)).join(", ")}`,
	);
	process.exit(1);
}
const py = process.env.CAPTION_EXPORT_PYTHON ?? "python3";
const run = spawnSync(py, [exporter, raw, cues, out], {
	env: process.env,
	encoding: "utf8",
});
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
console.log(`export exit ${run.status}`);
process.exit(run.status ?? 1);
