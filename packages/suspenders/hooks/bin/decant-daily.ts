#!/usr/bin/env bun
// hooks/bin/decant-daily.ts — W1212: the daily decant→facts RUNNER face.
// Invoked by the W779 heartbeat (MAINTENANCE_TASKS entry "decant-daily",
// daily 04:30 local) and by hand:
//
//   bun hooks/bin/decant-daily.ts [--window-hours N] [--limit N] [--dry-run] [--json]
//
// One pass: machine-local evidence (THIS machine's DONE work rows + THIS
// machine's decant archive) → mechanical claims → content-addressed coord
// facts via `coord fact set` children (CAS create-only, confidence-stamped).
// Credential-free by construction (local reads + local store) — hub-safe
// per W1211. Exit 0 = clean pass · 1 = collect or child errors (the sweep
// fail-logs; the cursor did not advance, the next fire re-collects).
import {
	DAILY_LIMIT,
	runDaily,
	type DailyRunResult,
} from "../lib/decant-daily.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

const daily = defineVerb({
	name: "decant-daily",
	usage:
		"usage: decant-daily [--window-hours N] [--limit N] [--dry-run] [--json]",
	flags: ["--window-hours", "--limit"],
	switches: ["--dry-run", "--json"],
});
const tokens = process.argv.slice(2);

const fail = (msg: string): never => {
	console.error(msg);
	process.exit(1);
};

if (tokens.includes("--help")) fail(daily.usage ?? "usage: decant-daily");
const outcome = parseVerb(daily, tokens);
if (!outcome.ok) fail(outcome.message);
const json = outcome.parsed.flag("--json") === "true";
const dryRun = outcome.parsed.flag("--dry-run") === "true";
const winRaw = outcome.parsed.flag("--window-hours");
const winHours = winRaw ? Number(winRaw) : NaN;
if (winRaw !== null && (!Number.isFinite(winHours) || winHours <= 0))
	fail("decant-daily: --window-hours must be a positive number");
const limitRaw = outcome.parsed.flag("--limit");
const limit = limitRaw ? Number(limitRaw) : DAILY_LIMIT;
if (limitRaw !== null && (!Number.isInteger(limit) || limit <= 0))
	fail("decant-daily: --limit must be a positive integer");

const result: DailyRunResult = runDaily({
	windowMs: Number.isFinite(winHours) ? winHours * 3_600_000 : undefined,
	limit,
	dryRun,
});

if (json) {
	console.log(JSON.stringify(result));
} else {
	console.log(
		`decant-daily: window since ${new Date(result.windowStartMs).toISOString()}`,
	);
	for (const k of result.created) console.log(`✓ created ${k}`);
	for (const k of result.reclaimed) console.log(`✓ reclaimed ${k}`);
	for (const k of result.tombstoned) console.log(`✓ retracted ${k}`);
	for (const k of result.deduped) console.log(`= deduped ${k}`);
	for (const k of result.planned) console.log(`· planned ${k}`);
	for (const s of result.skipped) console.error(`skip ${s}`);
	for (const e of result.errors) console.error(`✗ ${e}`);
}
process.exit(result.ok ? 0 : 1);
