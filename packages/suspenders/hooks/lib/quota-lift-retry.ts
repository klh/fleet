// hooks/lib/quota-lift-retry.ts — W804: a review leg parked on a provider
// quota wall (W738: opus-5-5 rides the Copilot seat, monthly reset
// ~2026-11-01) has no graph-native "requeue at date" — FAILED is a ledger
// dead-end (W761: retry is the legal requeue) and nothing schedules one.
// The W779 heartbeat carries it: a calendar task fires this daily; before
// the gate date it waits, at/after it it runs the same retryFailedItem()
// the work CLI retry verb uses, emits work.requeued on the bus, and is a
// self-retiring no-op from then on (requeued-READY, re-claimed, DONE —
// every non-FAILED state never re-triggers).
import type { GovernorStore } from "./govdb.ts";
import { retryFailedItem } from "./work-retry.ts";

export interface QuotaLiftVerdict {
	ok: boolean;
	/** waiting (pre-gate) | noop (self-retired) | requeued | missing | refused */
	action: "waiting" | "noop" | "requeued" | "missing" | "refused";
	detail: string;
}

/** "YYYY-MM-DD" → local midnight of that day (the gate is a local date). */
export function gateMs(gate: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gate);
	if (!m) throw new Error(`gate date must be YYYY-MM-DD, got "${gate}"`);
	return new Date(
		Number(m[1]),
		Number(m[2]) - 1,
		Number(m[3]),
		0,
		0,
		0,
		0,
	).getTime();
}

/** Comma-set of parked-leg item ids ("W738,W695.6.2,W731" — the W846 --tag
 * convention; ids never contain commas, so the split is unambiguous). */
export function parseQuotaItems(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function quotaLiftRetry(opts: {
	store: GovernorStore;
	project: string;
	id: string;
	gate: string;
	nowMs: number;
	emit?: (kind: string, note: string) => void;
}): QuotaLiftVerdict {
	const it = opts.store
		.query("SELECT state FROM work_items WHERE project=? AND id=?")
		.get(opts.project, opts.id) as { state: string } | undefined;
	if (!it)
		return {
			ok: false,
			action: "missing",
			detail: `no such work item: ${opts.id}`,
		};
	if (it.state !== "FAILED")
		return {
			ok: true,
			action: "noop",
			detail: `${opts.id} is ${it.state} — nothing to retry (self-retired)`,
		};
	if (opts.nowMs < gateMs(opts.gate))
		return {
			ok: true,
			action: "waiting",
			detail: `${opts.id} still quota-walled — gate ${opts.gate} (state FAILED, armed)`,
		};
	const r = retryFailedItem(opts.store, opts.project, opts.id);
	if (!r.ok)
		return { ok: false, action: "refused", detail: r.error ?? "retry refused" };
	opts.emit?.(
		"work.requeued",
		`${opts.id} requeued at quota lift (gate ${opts.gate}) — dispatch re-runs the parked leg`,
	);
	return {
		ok: true,
		action: "requeued",
		detail: `${opts.id} FAILED → READY at quota lift (gate ${opts.gate})`,
	};
}
