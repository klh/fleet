// W2787 — lane drift detection: per-class windows, threshold + min-sample
// gates, idempotent lane.drift emission. Hermetic in-memory events table.
import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import type { GovernorStore } from "../govdb/govdb-store.ts";
import {
	computeDrift,
	driftAlertLine,
	driftLine,
	emitDriftAlerts,
	readDriftAlerts,
	readDriftRows,
	topGroup,
} from "./lane-drift.ts";

const PROJ = "/repo/.git";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const OPTS = { now: NOW, windowMs: 7 * DAY, minSamples: 5, thresholdPts: 15 };

function store(): Database {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)",
	);
	return d;
}

const put = (d: Database, ts: number, kind: string, p: object): void => {
	d.prepare(
		"INSERT INTO events (ts, source, kind, payload) VALUES (?, 't', ?, ?)",
	).run(ts, kind, JSON.stringify({ project: PROJ, ...p }));
};

const attribute = (d: Database, work: string, group: string): void =>
	put(d, NOW - 20 * DAY, "work.attribution", {
		work,
		backfill: JSON.stringify({ groups: { [group]: { in: 10, out: 5 } } }),
	});

const review = (d: Database, ts: number, work: string, pass: boolean): void =>
	put(d, ts, "work.review", {
		work,
		verdict: pass ? "PASS" : "FAIL",
		receipt: JSON.stringify({ blocking: pass ? [] : ["a", "b", "c"] }),
	});

/** 10 reviews last week at 90% PASS, 10 this week at 40% for class m1. */
function seeded(): Database {
	const d = store();
	attribute(d, "W1", "m1");
	for (let i = 0; i < 10; i++) {
		review(d, NOW - 10 * DAY + i, "W1", i < 9);
		review(d, NOW - 2 * DAY + i, "W1", i < 4);
	}
	return d;
}

test("@unit W2787 PASS-rate drop beyond threshold alerts for the class", () => {
	const d = seeded();
	const [c] = computeDrift(readDriftRows(d, PROJ, NOW - 14 * DAY), OPTS);
	expect(c.lane_class).toBe("m1");
	expect(c.pass_rate).toEqual({ previous: 90, current: 40 });
	expect(c.alerts.map((a) => a.metric).sort()).toEqual([
		"blocking_per_review",
		"review_pass_rate",
	]);
	expect(driftLine(c)).toContain("⚠ review_pass_rate -50");
});

test("@unit W2787 below minSamples or within threshold never alerts", () => {
	const d = seeded();
	const rows = readDriftRows(d, PROJ, 0);
	expect(computeDrift(rows, { ...OPTS, minSamples: 11 })[0].alerts).toEqual([]);
	expect(
		computeDrift(rows, { ...OPTS, thresholdPts: 60 })[0].alerts.map(
			(a) => a.metric,
		),
	).toEqual(["blocking_per_review"]);
});

test("@unit W2787 unattributed items, done/retry/refusal tallies, other projects excluded", () => {
	const d = store();
	put(d, NOW - DAY, "work.done", { work: "W9", verified: false });
	put(d, NOW - DAY, "work.retried", { work: "W9" });
	put(d, NOW - DAY, "NEED_DECISION", { work: "W9", code: "claim_stale" });
	d.prepare(
		"INSERT INTO events (ts, source, kind, payload) VALUES (?, 't', 'work.done', ?)",
	).run(NOW - DAY, JSON.stringify({ project: "/other/.git", work: "W9" }));
	const [c] = computeDrift(readDriftRows(d, PROJ, 0), OPTS);
	expect(c.lane_class).toBe("unattributed");
	expect(c.current).toMatchObject({
		done: 1,
		unverified: 1,
		retries: 1,
		refusals: { claim_stale: 1 },
	});
});

test("@unit W2787 emission is idempotent per class+metric+window", () => {
	const d = seeded();
	const alerts = computeDrift(readDriftRows(d, PROJ, 0), OPTS).flatMap(
		(c) => c.alerts,
	);
	const emit = (kind: string, _s: string, extra: Record<string, string>) => {
		put(d, NOW, kind, extra);
		return Number(
			(d.query("SELECT max(id) AS id FROM events").get() as { id: number }).id,
		);
	};
	const db = d as unknown as GovernorStore;
	expect(emitDriftAlerts(db, PROJ, alerts, OPTS, emit)).toHaveLength(2);
	expect(emitDriftAlerts(db, PROJ, alerts, OPTS, emit)).toEqual([]);
});

test("@unit W2787 topGroup picks the heaviest model_group", () => {
	expect(
		topGroup(
			JSON.stringify({
				groups: { a: { in: 1 }, b: { out: 9 }, c: { in: 0 } },
			}),
		),
	).toBe("b");
	expect(topGroup("nope")).toBeNull();
	expect(topGroup(undefined)).toBeNull();
});

test("@unit W2794 readDriftAlerts reads emitted alerts, ages them out, skips malformed", () => {
	const d = store();
	const alert = { previous: "90", current: "40", delta: "-50" };
	put(d, NOW - DAY, "lane.drift", {
		...alert,
		drift_key: "m1|review_pass_rate|1",
		lane_class: "m1",
		metric: "review_pass_rate",
	});
	// aged out (8d > the 7d maxAge default), malformed (no metric), and
	// another project's alert — none of these may surface
	put(d, NOW - 8 * DAY, "lane.drift", {
		...alert,
		lane_class: "old",
		metric: "review_pass_rate",
	});
	put(d, NOW - DAY, "lane.drift", { lane_class: "bad" });
	put(d, NOW - DAY, "lane.drift", {
		...alert,
		lane_class: "m2",
		metric: "blocking_per_review",
		project: "/other/.git",
	});
	const rows = readDriftAlerts(d as unknown as GovernorStore, PROJ, NOW);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		lane_class: "m1",
		metric: "review_pass_rate",
		...alert,
	});
	expect(driftAlertLine(rows[0])).toBe("m1 review_pass_rate 90→40 (Δ-50)");
});
