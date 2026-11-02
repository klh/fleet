// review-park.ts — W2548: bounded transport re-admission. W1243 made
// transport failures refund their verdict attempt and retry unboundedly at
// capped backoff — correct for a brief upstream flap, but under a starved
// provider pool (the 2026-11-02 census: 338 local-503 + 91 local-429 legs in
// the latest-500 ERROR sample) every knock walks the full 3-tier ladder
// (glm-5.3-flash x3, glm-5.3 x3, local-coder — 43-590s per leg, the W2546
// leg burned 390s on ONE non-streaming 504) against implementation lanes
// that need the same slots. After SUSPENDERS_REVIEW_TRANSPORT_PARK (default
// 6, ~45-90min of knocks at W1243 backoff) consecutive transport deferrals,
// the request parks: state PARKED, one advisory NEED_DECISION per park
// episode, no further automatic re-admission until an explicit controller/
// owner release (coord review-unpark). W1243's capped backoff stays; the
// park is the only new ceiling and it never fires on verdict-bearing legs.
// Schema law: the knob is zod-parsed (0 disables the park — the operator's
// unbounded W1243 behavior on demand).

import { z } from "zod";
import { emitStoredEvent } from "../../coord/event-publish.ts";
import type { GovernorStore } from "../govdb/govdb-store.ts";

export const PARK_SOURCE = "review-park";
/** The item's park counter key — the epoch survives releases (it counts
 * episodes, never a live-park marker); the release verb bumps nothing. */
export const reviewParkKey = (project: string, item: string): string =>
	`review.park.${project}.${item}`;

const ParkKnobSchema = z.union([z.literal("0"), z.string().regex(/^\d+$/)]);

/** The configured park threshold: unset/blank/junk → 6; a non-negative
 * integer overrides; 0 disables the park (unbounded W1243 retry). */
export function reviewTransportPark(env: NodeJS.ProcessEnv): number {
	const raw = env.SUSPENDERS_REVIEW_TRANSPORT_PARK?.trim();
	const parsed = ParkKnobSchema.safeParse(raw);
	return parsed.success ? Number(parsed.data) : 6;
}

/** The item's park epoch — how many times it has parked (0 = never). */
function parkEpoch(db: GovernorStore, project: string, item: string): number {
	try {
		const row = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(reviewParkKey(project, item)) as { value: string } | null;
		return row ? (JSON.parse(row.value).epoch ?? 0) : 0;
	} catch {
		return 0;
	}
}

/** Flip an ERROR request whose consecutive transport deferrals reached the
 * threshold to PARKED and emit the one-per-episode advisory. Called inside
 * the admission gate, where env/author are in hand. Returns true when the
 * row is now parked (the caller turns that into its refusal string).
 * Writes the `.parked-at` companion fact the release verb scopes by — the
 * request key hashes the full review context, so project/item live there. */
export function parkReviewRequest(o: {
	db: GovernorStore;
	key: string;
	request: { state: string; deferred?: number };
	project: string;
	item: string;
	author: string;
}): boolean {
	if (o.request.state !== "ERROR" || !o.request.deferred) return false;
	const now = Date.now();
	const parked = JSON.stringify({ ...o.request, state: "PARKED" });
	const parkedAt = JSON.stringify({
		project: o.project,
		item: o.item,
		ts: now,
	});
	const epoch = parkEpoch(o.db, o.project, o.item) + 1;
	const upsert =
		"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts";
	o.db
		.query("UPDATE facts SET value=?, version=version+1, ts=? WHERE key=?")
		.run(parked, now, o.key);
	o.db.query(upsert).run(`${o.key}.parked-at`, parkedAt, PARK_SOURCE, now);
	o.db
		.query(upsert)
		.run(
			reviewParkKey(o.project, o.item),
			JSON.stringify({ epoch, deferred: o.request.deferred, ts: now }),
			PARK_SOURCE,
			now,
		);
	try {
		emitParkDecision(
			o.db,
			o.project,
			o.item,
			o.author,
			o.request.deferred,
			epoch,
		);
	} catch {
		// the park stands even when the advisory event cannot be written
	}
	return true;
}

/** One advisory NEED_DECISION per (item, park episode) to the completion
 * author — the dedupe shape mirrors the round cap (review-round-cap.ts). */
function emitParkDecision(
	db: GovernorStore,
	project: string,
	item: string,
	author: string,
	deferred: number,
	epoch: number,
): void {
	const prior = db
		.query(
			"SELECT id FROM events WHERE kind = 'NEED_DECISION' AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.work') = ? AND json_extract(payload, '$.review_park') = ? LIMIT 1",
		)
		.get(project, item, String(epoch));
	if (prior) return;
	emitStoredEvent(db, project, {
		kind: "NEED_DECISION",
		source: PARK_SOURCE,
		scope: item,
		to: author,
		note: `${item}: review transport parked after ${deferred} consecutive deferrals — the reviewer stops knocking (provider pool starved; each leg was walking the full fallback ladder against implementation lanes). Release explicitly (coord review-unpark ${item}) once the provider recovers, or set SUSPENDERS_REVIEW_TRANSPORT_PARK higher / 0 (disable) to keep retrying.`,
		extra: {
			work: item,
			review_park: String(epoch),
			deferred: String(deferred),
		},
	});
}

/** The explicit release: flips every PARKED request row the item owns back
 * to ERROR at a fresh deferral count (the next schedule call re-admits at
 * W1243 backoff — one grace knock, then the counter climbs again toward a
 * new episode) and drops the `.parked-at` companions. The epoch fact
 * survives (it counts episodes), so the next park emits a fresh advisory.
 * Returns the number of request rows released. */
export function releaseReviewPark(
	db: GovernorStore,
	project: string,
	item: string,
): number {
	let released = 0;
	const rows = db
		.query("SELECT key, value FROM facts WHERE source = 'review-scheduler'")
		.all() as { key: string; value: string }[];
	for (const row of rows) {
		if (JSON.parse(row.value).state !== "PARKED") continue;
		const parkedAt = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`${row.key}.parked-at`) as { value: string } | null;
		if (!parkedAt) continue;
		let scope: { project?: string; item?: string };
		try {
			scope = JSON.parse(parkedAt.value);
		} catch {
			continue;
		}
		if (scope.project !== project || scope.item !== item) continue;
		const fresh: Record<string, unknown> = JSON.parse(row.value);
		fresh.state = "ERROR";
		fresh.deferred = 0;
		fresh.nextAt = 0;
		db.query(
			"UPDATE facts SET value=?, version=version+1, ts=? WHERE key=?",
		).run(JSON.stringify(fresh), Date.now(), row.key);
		db.query("DELETE FROM facts WHERE key = ?").run(`${row.key}.parked-at`);
		released += 1;
	}
	return released;
}
