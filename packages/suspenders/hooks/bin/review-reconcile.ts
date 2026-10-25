// review-reconcile.ts — W1280 stale-reviewer-leg sweep. Scans RUNNING review
// requests, probes each reviewer's stamped pid, and finishes the dead ones
// (attempt refund + capped backoff) instead of stranding them for the full
// 25-minute lease. Fired by the fleet-loop maintenance registry (review-
// reconcile, every 300s); also safe to run by hand.
// usage: bun review-reconcile.ts
import { openStore } from "../lib/govdb.ts";
import {
	providerPressureOf,
	reconcileReviewLegs,
} from "../lib/review-scheduler.ts";

const db = openStore();
try {
	const summary = reconcileReviewLegs(db);
	const pressure = providerPressureOf(db);
	console.log(
		`review-reconcile: examined=${summary.examined} active=${summary.active} stale=${summary.stale} recovered=${summary.recovered} pressure.fails=${pressure.fails} pressure.openUntil=${pressure.openUntil}`,
	);
} finally {
	db.close();
}
