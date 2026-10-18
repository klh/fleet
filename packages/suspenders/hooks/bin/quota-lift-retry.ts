#!/usr/bin/env bun
// hooks/bin/quota-lift-retry.ts — W804: the W779 heartbeat's quota-lift
// requeue face. A review leg parked on a provider quota wall (W738: opus-5-5
// rides the Copilot seat, monthly reset ~2026-11-01) can't be reclaimed —
// work retry is the legal requeue, and it must fire LATER. This runner (the
// MAINTENANCE_TASKS "quota-lift-retry" task, daily 09:00 local) waits out
// the gate date, then requeues + emits work.requeued so the board shows the
// lift fired. Self-retiring: a non-FAILED state never re-triggers, so the
// day the retry lands (or the item closes) the task degrades to a no-op.
//
//   bun hooks/bin/quota-lift-retry.ts --item W738 --after 2026-11-01 [--json]
//
// Exit 0 = armed-waiting / no-op / requeued · 1 = item missing or retry
// refused (the sweep fail-logs it; the next daily fire retries).
import { openStore, projectIdentity } from "../lib/govdb.ts";
import { gateMs, quotaLiftRetry } from "../lib/quota-lift-retry.ts";

const argv = process.argv.slice(2);
const val = (flag: string): string | undefined => {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
};
const json = argv.includes("--json");
const item = val("--item");
const gate = val("--after");

const fail = (msg: string): never => {
	console.error(msg);
	process.exit(1);
};
if (!item || !gate)
	fail("usage: quota-lift-retry --item <id> --after YYYY-MM-DD [--json]");

try {
	gateMs(gate);
} catch (e) {
	fail(e instanceof Error ? e.message : String(e));
}

const store = openStore();
const r = quotaLiftRetry({
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
});

if (json) {
	console.log(JSON.stringify(r));
} else if (r.ok) {
	console.log(`✓ ${r.detail}`);
} else {
	console.error(`✗ ${r.detail}`);
}
process.exit(r.ok ? 0 : 1);
