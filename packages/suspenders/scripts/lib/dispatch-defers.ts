// scripts/lib/dispatch-defers.ts — W1145: item-local dispatch deferrals.
// dispatchItem's null returns split two classes: item-local deferrals (the
// item's own tree/claim/brief state — residue guards, claimed-elsewhere,
// brief refusal) and global holds (unclassified create failure, provider walls, host
// pressure, live/unknown guards, launch failures). The plaid refill loop
// stops on global holds only; an item-local deferral lets the remaining
// READY pool proceed. The guards themselves are untouched: residue is never
// discarded, the item still refuses its own spawn — other items just stop
// losing their turn to it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { RETRY_STEPS_MS } from "./launch-backoff.ts";
import { isResumableClaim } from "./resumable-claim.ts";

const deferred: string[] = [];
/** Record an item-local deferral; returns null so call sites read
 *  `return deferItem(item, evidence, sid, fleetDir);` at the existing SKIP
 *  exits. fleetDir stamps the persisted requeueAt (W2315); omitted (or in
 *  DRY mode) the deferral stays run-local. */
export const deferItem = (
	item: string,
	evidence?: { code: number; out: string },
	sid?: string,
	fleetDir?: string,
): null => {
	// A failed command/unreadable row is a global unknown, not proof of contention.
	if (evidence !== undefined) {
		if (evidence.code !== 0 || !sid) return null;
		try {
			const row: unknown = JSON.parse(evidence.out);
			const owner =
				row && typeof row === "object"
					? (row as Record<string, unknown>).owner_sid
					: null;
			if (
				typeof owner !== "string" ||
				!owner.trim() ||
				owner === sid ||
				!isResumableClaim(evidence.out, item, owner)
			)
				return null;
		} catch {
			return null;
		}
	}
	deferred.push(item);
	if (fleetDir) recordDeferral(fleetDir, item);
	return null;
};

// W2315 BestEffortFIFO: a deferral outlives the dispatch run — it lands a
// requeueAt on the launch-backoff ladder in `.fleet/dispatch-defers.json`,
// and the READY-pool refill skips the item until it expires (Kueue's
// requeueState {count, requeueAt}, fleet-sized).
export const DEFERS_FILE = "dispatch-defers.json";
export interface DeferRecord {
	item: string;
	failures: number;
	/** epoch ms after which the item is refill-eligible until */
	requeueAt: number;
}
const DeferRecordSchema = z.object({
	item: z.string().min(1),
	failures: z.number().int().nonnegative(),
	requeueAt: z.number().finite(),
});
const defersFileSchema = z.array(DeferRecordSchema);

const defersPath = (fleetDir: string): string => join(fleetDir, DEFERS_FILE);

const readDefers = (fleetDir: string): DeferRecord[] => {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(defersPath(fleetDir), "utf8"),
		);
		const rows = defersFileSchema.safeParse(parsed);
		return rows.success ? rows.data : [];
	} catch {
		// dark defers file: fail-open, nothing is pending
		return [];
	}
};

/** Write-side of the requeue backoff: failures counts consecutive deferrals,
 * requeueAt walks the launch-backoff ladder (5s→55s). Expired rows are
 * pruned on write; a dark .fleet never blocks dispatch. */
export const recordDeferral = (
	fleetDir: string,
	item: string,
	now = Date.now(),
): DeferRecord => {
	const rows = readDefers(fleetDir);
	const failures = (rows.find((r) => r.item === item)?.failures ?? 0) + 1;
	const step = RETRY_STEPS_MS[Math.min(failures - 1, RETRY_STEPS_MS.length - 1)];
	const row: DeferRecord = { item, failures, requeueAt: now + step };
	try {
		mkdirSync(fleetDir, { recursive: true });
		writeFileSync(
			defersPath(fleetDir),
			`${JSON.stringify(
				[...rows.filter((r) => r.item !== item && r.requeueAt > now), row],
				null,
				"\t",
			)}\n`,
		);
	} catch {
		// a dark .fleet never blocks dispatch
	}
	return row;
};

/** The item's deferral record, when its requeueAt is still in the future. */
export const deferralOf = (
	fleetDir: string,
	item: string,
	now = Date.now(),
): DeferRecord | null =>
	readDefers(fleetDir).find((r) => r.item === item && r.requeueAt > now) ??
	null;

/** true when the item was deferred and its requeueAt has not expired. */
export const requeuePending = (
	fleetDir: string,
	item: string,
	now = Date.now(),
): boolean => deferralOf(fleetDir, item, now) !== null;

/** A successful dispatch retires the item's backoff. */
export const clearDeferral = (fleetDir: string, item: string): void => {
	try {
		const rows = readDefers(fleetDir);
		if (!rows.some((r) => r.item === item)) return;
		writeFileSync(
			defersPath(fleetDir),
			`${JSON.stringify(rows.filter((r) => r.item !== item), null, "\t")}\n`,
		);
	} catch {
		// fail-soft: a stale backoff row is never fatal
	}
};
/** true when this dispatch run deferred the item for an item-local reason. */
export const isDeferredItem = (item: string): boolean =>
	deferred.includes(item);

/** W2331 (Kueue F2, cluster_queue.go:624): the requirement shape key —
 *  the sorted requires set. Structurally identical items share it. */
export const shapeKey = (requires: string[]): string =>
	[...requires].sort().join(",");

/** Equivalence-shape bulk deferral: when a refill refusal is capability-
 *  starved, every READY sibling with the same requirement shape rides the
 *  W2315 requeue ladder in the same cycle instead of each burning its own.
 *  Records a deferral for every pool row matching a starved shape (the
 *  starved row itself included — it climbs the ladder with its siblings). */
export const deferEquivalenceClass = (
	fleetDir: string,
	pool: { id: string; requires: string[] }[],
	starvedRows: { id: string; requires: string[] }[],
	now = Date.now(),
): DeferRecord[] => {
	const starvedShapes = new Set(starvedRows.map((r) => shapeKey(r.requires)));
	return pool
		.filter((r) => starvedShapes.has(shapeKey(r.requires)))
		.map((r) => recordDeferral(fleetDir, r.id, now));
};
