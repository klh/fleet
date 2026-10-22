#!/usr/bin/env bun
// hooks/bin/quota-lift-retry.ts — W804/W782.1: the W779 heartbeat's quota-lift
// requeue face. Parked legs on a provider quota wall can't be reclaimed —
// work retry is the legal requeue, and it must fire LATER. This runner (the
// MAINTENANCE_TASKS "quota-lift-retry" task, daily 09:00 local) waits out
// the gate date, then requeues each parked item + emits work.requeued so
// the board shows the lift fired. The W782.1 parked legs ride the SAME
// Copilot seat reset (~2026-11-01): W738 opus-5-5 re-review, W695.6.2
// tool_use proof, W731 copilot digest, W1202.1 sampling-param retest (the
// removed Claude temperature/top_p/top_k). Self-retiring per item: a non-FAILED state
// never re-triggers, so the day each retry lands (or the item closes) its
// leg degrades to a no-op.
//
//   bun hooks/bin/quota-lift-retry.ts --item W738,W695.6.2,W731 --after 2026-11-01 [--json]
//
// Exit 0 = armed-waiting / no-ops / requeued · 1 = any item missing or
// retry refused (the sweep fail-logs it; the next daily fire retries —
// requeued/noop legs self-retire, so only the refused set re-fires).
import { openStore, projectIdentity } from "../lib/govdb.ts";
import {
	gateMs,
	parseQuotaItems,
	quotaLiftRetry,
} from "../lib/quota-lift-retry.ts";
import { defineVerb, parseVerb } from "../lib/verb-kit.ts";

// W669.12.3: parse rides verb-kit (W651) — declared flags, kit owns argv.
const retry = defineVerb({
	name: "quota-lift-retry",
	usage:
		"usage: quota-lift-retry --item <id>[,<id>...] --after YYYY-MM-DD [--json]",
	flags: ["--item", "--after"],
	switches: ["--json"],
	reqFlags: ["--item", "--after"],
});
const tokens = process.argv.slice(2);

const fail = (msg: string): never => {
	console.error(msg);
	process.exit(1);
};

if (tokens.includes("--help")) fail(retry.usage ?? "usage: quota-lift-retry");
const outcome = parseVerb(retry, tokens);
if (!outcome.ok) fail(outcome.message);
const json = outcome.parsed.flag("--json") === "true";
const gate = outcome.parsed.flag("--after");
const items = parseQuotaItems(outcome.parsed.flag("--item") ?? "");
if (items.length === 0 || !gate)
	fail("quota-lift-retry: --item and --after required");

try {
	gateMs(gate);
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}

const store = openStore();
const results = items.map((item) =>
	quotaLiftRetry({
		store,
		project: projectIdentity(),
		id: item,
		gate,
		nowMs: Date.now(),
		emit: (kind, note) => {
			const { emitEvent } = require("../coord/bus.ts") as {
				emitEvent: (o: {
					kind: string;
					note: string;
					source: string;
				}) => number;
			};
			emitEvent({ kind, note, source: "quota-lift-retry" });
		},
	}),
);

if (json) {
	console.log(JSON.stringify(results));
} else {
	for (const r of results) {
		if (r.ok) console.log(`✓ ${r.detail}`);
		else console.error(`✗ ${r.detail}`);
	}
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
