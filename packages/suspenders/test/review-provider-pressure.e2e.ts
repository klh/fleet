// test/review-provider-pressure.e2e.ts — W3012: per-provider AIMD pressure
// and the deterministic-refusal decoupling. The 2026-11-11 storm specimen:
// ONE shared ledger key paused every provider group off a single provider's
// 429/503 wave (44 pending / 0 admitted for hours), and deterministic
// policy/input refusals (diff budget, bounded audit, blocking-findings cap)
// re-armed that same ledger on every backoff — healthy groups starved
// behind one provider's transient pressure. These seams pin: a failure on
// one group never pauses another; refusals keep W1243's refund/backoff but
// never re-arm AIMD; transport finishes still re-arm (their own group);
// pre-W3012 legacy rows (no model) still feed the legacy global ledger and
// its time-bounded window/probe conservatively holds new groups.
import { expect, test } from "@playwright/test";
import {
	applyPressure,
	deterministicRefusal,
	finishReviewRequest,
	providerPressureAggregate,
	providerPressureKey,
	providerPressureKeyOf,
	providerPressureOf,
	reviewRequestKey,
	scheduleReview,
} from "../hooks/lib/gates/review-scheduler.ts";
import {
	type GovernorStore,
	openMemoryStore,
} from "../hooks/lib/govdb/govdb-store.ts";

const FM = "fixture-model";
const stores: GovernorStore[] = [];
test.afterEach(() => {
	for (const db of stores.splice(0)) db.close();
});
function fixture() {
	const db = openMemoryStore();
	stores.push(db);
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
	);
	db.run(
		"CREATE TABLE work_completion_records(project TEXT,item TEXT,commit_sha TEXT,completed_by TEXT)",
	);
	const context = {
		commit: "a".repeat(40),
		base: "b".repeat(40),
		instructions: {},
		text: "",
	};
	for (const item of ["W1", "W2", "W3"])
		db.query(
			"INSERT INTO work_completion_records VALUES ('fixture',?,?,'author')",
		).run(item, context.commit);
	const options = {
		db,
		project: "fixture",
		item: "W1",
		repo: ".",
		context,
		env: { SUSPENDERS_REVIEW_MODEL: FM },
	};
	const launches: string[][] = [];
	return {
		db,
		context,
		options,
		launches,
		spawn: (args: string[]) => launches.push(args),
	};
}
const keyOf = (f: ReturnType<typeof fixture>, item = "W1"): string =>
	reviewRequestKey("fixture", item, f.context);
const requestOf = (
	f: ReturnType<typeof fixture>,
	item = "W1",
): {
	token: string;
	state: string;
	model?: string;
	deferred?: number;
	proof_park_at?: number;
	wire_park_at?: number;
} =>
	JSON.parse(
		(
			f.db.query("SELECT value FROM facts WHERE key=?").get(keyOf(f, item)) as {
				value: string;
			}
		).value,
	);
/** Time-travel: rewrite the FM group ledger row. */
const setGroupPressure = (
	db: GovernorStore,
	p: Record<string, unknown>,
): void => {
	const now = Date.now();
	const current = providerPressureOf(db, FM);
	db.query(
		"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
	).run(
		providerPressureKeyOf(FM),
		JSON.stringify({ ...current, updated: now, ...p }),
		now,
	);
};
/** Time-travel: rewrite the legacy global ledger row. */
const setLegacyPressure = (
	db: GovernorStore,
	p: Record<string, unknown>,
): void => {
	const now = Date.now();
	const current = providerPressureOf(db);
	db.query(
		"INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,'review-scheduler',1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, version=facts.version+1,ts=excluded.ts",
	).run(
		providerPressureKey,
		JSON.stringify({ ...current, updated: now, ...p }),
		now,
	);
};

test("reserve stamps the routed group into the request row", () => {
	const f = fixture();
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	expect(requestOf(f).model).toBe(FM);
});

test("a ZAI failure never pauses a healthy claude group (or vice versa)", () => {
	const f = fixture();
	// provider A saturates: two transport failures on its own ledger row
	applyPressure(f.db, true, "zai-model");
	applyPressure(f.db, true, "zai-model");
	const zai = providerPressureOf(f.db, "zai-model");
	expect(zai.fails).toBe(2);
	expect(zai.openUntil).toBeGreaterThan(Date.now());
	// provider B (the fixture's routed group) admits straight through
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
	expect(f.launches).toHaveLength(1);
	// and B's reserve left A's ledger untouched
	expect(providerPressureOf(f.db, "zai-model")).toEqual(zai);
});

test("diff-budget refusal keeps the refund/backoff but never re-arms AIMD", () => {
	const f = fixture();
	scheduleReview({ ...f.options, spawn: f.spawn });
	const req = requestOf(f);
	finishReviewRequest(
		f.db,
		keyOf(f),
		req.token,
		true,
		"review-lane: full exact diff unavailable or exceeds review budget; decompose before approval",
	);
	const after = requestOf(f);
	expect(after.state).toBe("ERROR");
	expect(after.attempts).toBe(0); // W1243 verdict budget refunded
	expect(after.deferred).toBe(1);
	expect(after.proof_park_at).toBeUndefined(); // not a park class
	expect(after.wire_park_at).toBeUndefined();
	expect(providerPressureOf(f.db, FM).fails).toBe(0);
	expect(providerPressureOf(f.db, FM).openUntil).toBe(0);
	expect(providerPressureAggregate(f.db).fails).toBe(0);
});

test("blocking-findings cap refusal never re-arms AIMD either", () => {
	const f = fixture();
	scheduleReview({ ...f.options, spawn: f.spawn });
	const req = requestOf(f);
	finishReviewRequest(
		f.db,
		keyOf(f),
		req.token,
		true,
		"too many prior blocking findings for review prompt",
	);
	expect(requestOf(f).state).toBe("ERROR");
	expect(providerPressureOf(f.db, FM).fails).toBe(0);
	expect(providerPressureAggregate(f.db).fails).toBe(0);
});

test("transport failure re-arms only its own group; served drains only its own group", () => {
	const f = fixture();
	applyPressure(f.db, true, "zai-model"); // neighbor group saturated
	scheduleReview({ ...f.options, spawn: f.spawn });
	const req = requestOf(f);
	finishReviewRequest(f.db, keyOf(f), req.token, true); // transport failure
	const fm = providerPressureOf(f.db, FM);
	expect(fm.fails).toBe(1);
	expect(fm.openUntil).toBeGreaterThan(Date.now());
	// the neighbor's ledger row is untouched by this finish
	expect(providerPressureOf(f.db, "zai-model").fails).toBe(1);
	// a served verdict on the NEXT FM leg decays FM memory only
	setGroupPressure(f.db, { openUntil: Date.now() - 1 }); // window lapses
	scheduleReview({ ...f.options, item: "W2", spawn: f.spawn });
	const w2 = requestOf(f, "W2");
	finishReviewRequest(f.db, keyOf(f, "W2"), w2.token, false);
	const decayed = providerPressureOf(f.db, FM);
	expect(decayed.fails).toBe(0); // 1 → 0: halved to zero, fully reopened
	expect(decayed.openUntil).toBe(0);
	expect(providerPressureOf(f.db, "zai-model").fails).toBe(1);
});

test("deterministicRefusal classifies the refusal strings, not transport", () => {
	expect(
		deterministicRefusal(
			"review-lane: full exact diff unavailable or exceeds review budget; decompose before approval",
		),
	).toBe(true);
	expect(
		deterministicRefusal("exact-commit review history exceeds bounded audit"),
	).toBe(true);
	expect(
		deterministicRefusal("too many prior blocking findings for review prompt"),
	).toBe(true);
	// transport-shaped and park-shaped reasons are NOT refusals
	expect(deterministicRefusal("reviewer exited 1 at launch: boom")).toBe(false);
	expect(
		deterministicRefusal(
			"wire-model fallback: served by cross-family wire model",
		),
	).toBe(false);
	expect(deterministicRefusal(undefined)).toBe(false);
});

test("legacy in-flight rows still feed the legacy global ledger", () => {
	const f = fixture();
	scheduleReview({ ...f.options, spawn: f.spawn });
	// time-travel the row back to the pre-W3012 shape: no routed model
	const req = requestOf(f);
	delete req.model;
	f.db
		.query("UPDATE facts SET value=? WHERE key=?")
		.run(JSON.stringify(req), keyOf(f));
	finishReviewRequest(f.db, keyOf(f), req.token, true); // transport failure
	expect(providerPressureOf(f.db).fails).toBe(1); // legacy global row
	expect(providerPressureOf(f.db).openUntil).toBeGreaterThan(Date.now());
	expect(providerPressureOf(f.db, FM).fails).toBe(0); // FM row untouched
	// the legacy window conservatively defers a new FM admission
	expect(
		scheduleReview({ ...f.options, item: "W2", spawn: f.spawn }),
	).toContain("provider pressure");
});

test("a legacy canary probe conservatively holds new groups until it lapses", () => {
	const f = fixture();
	// pre-W3012 stamp: probe on the legacy global row, window lapsed
	setLegacyPressure(f.db, {
		fails: 1,
		openUntil: Date.now() - 1,
		probe: { key: "some-legacy-canary", until: Date.now() + 60_000 },
	});
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"probe in flight",
	);
	// once the legacy probe lapses, admission proceeds normally
	setLegacyPressure(f.db, { probe: undefined });
	expect(scheduleReview({ ...f.options, spawn: f.spawn })).toContain(
		"requested through Buckle",
	);
});

test("providerPressureAggregate folds the worst case across groups", () => {
	const f = fixture();
	applyPressure(f.db, true, "zai-model");
	applyPressure(f.db, true, "claude-sonnet-5");
	applyPressure(f.db, true, "claude-sonnet-5");
	const agg = providerPressureAggregate(f.db);
	expect(agg.fails).toBe(2); // max across rows
	expect(agg.openUntil).toBeGreaterThan(Date.now());
});
