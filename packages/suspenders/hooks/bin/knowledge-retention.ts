#!/usr/bin/env bun
// hooks/bin/knowledge-retention.ts — CLI face of the W2845 knowledge
// retention watermark (hooks/lib/knowledge/knowledge-retention.ts).
// Prunes terminal (retired|graveyard) knowledge rows past the
// retention_days window (~/.config/klh/knowledge.json, default 90) by
// flipping them to state='archived' — the read-side watermark: excluded
// from recall (never live), every field kept (confidence + provenance
// survive the prune), append-only intact (no DELETE). Never touches live
// rows; one summary event per pruning pass (ids + count, no fact text).
// Dry-run is the default; --act performs the flips. The fleet-loop
// maintenance registry (W779) fires it with --act every 6h.
// `.fleet/knowledge-retention-paused` pauses (the retires-paused idiom).
//
//   bun hooks/bin/knowledge-retention.ts [--act] [--json] [--repo <dir>]
import { existsSync } from "node:fs";
import {
	knowledgeConfPath,
	readRetentionConfig,
	retentionSweep,
	type RetentionSweep,
} from "../lib/knowledge/knowledge-retention.ts";
import { withKnowledgeDb } from "../lib/knowledge/sqlite-store.ts";
import { emitLoopEvent } from "../lib/fleet-loop/events.ts";
import {
	defineVerb,
	dieFor,
	parseVerb,
	renderVerbHelp,
} from "../lib/verb-kit.ts";

const SPEC = defineVerb({
	name: "knowledge-retention",
	usage:
		"usage: bun knowledge-retention.ts [--act] [--json] [--repo <dir>] [--days <n>]",
	flags: ["--repo", "--days"],
	switches: ["--act", "--json"],
});

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
	console.log(renderVerbHelp(SPEC));
	process.exit(0);
}
const outcome = parseVerb(SPEC, argv);
if (!outcome.ok)
	dieFor("knowledge-retention")(outcome.message || (SPEC.usage ?? ""));
const act = outcome.parsed.flag("--act") === "true";
const json = outcome.parsed.flag("--json") === "true";
const repo = outcome.parsed.flag("--repo") ?? process.cwd();

// the pause file parks the runner (ops hatch, the rogue-reap idiom);
// readRetentionConfig throws LOUD on a malformed conf — never a silent
// wrong window (drift fails loud, the W1238.4 doctrine).
const paused = existsSync(`${repo}/.fleet/knowledge-retention-paused`);
const conf = readRetentionConfig(knowledgeConfPath());
const daysOverride = outcome.parsed.flag("--days");
const retentionDays = daysOverride ? Number(daysOverride) : conf.retention_days;

// withKnowledgeDb is the W1228 consumer face — only the store owner opens
// knowledge.db directly (W92). The event rides emitLoopEvent (openStore);
// a sweep without a prunable row needs no event, so the bus opens lazily
// inside the emitter, never here.
const res: RetentionSweep =
	paused || retentionDays <= 0
		? { retentionDays, candidates: 0, archived: [] }
		: withKnowledgeDb((kb) => {
				const out = retentionSweep(kb, { retentionDays, act });
				if (out.archived.length > 0)
					emitLoopEvent("knowledge.retention", "knowledge", {
						archived: out.archived.map((a) => a.id),
						count: out.archived.length,
						retention_days: retentionDays,
					});
				return out;
			});
if (json) {
	console.log(
		JSON.stringify({
			act,
			paused,
			retentionDays,
			candidates: res.candidates,
			archived: act ? res.archived : [],
		}),
	);
} else {
	for (const a of res.archived)
		console.log(`archived k#${a.id} — terminal past ${retentionDays}d`);
	console.log(
		`knowledge-retention${act ? "" : " (dry-run)"}${paused ? " · PAUSED" : ""}: ${act ? res.archived.length : res.candidates} due, ${act ? res.archived.length : 0} archived (window ${retentionDays}d)`,
	);
}
