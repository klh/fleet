// w2978-transport-stall.e2e.ts — W2978: the merge ladder's stuck alarm
// distinguishes self-healing review-transport stalls from genuine refusal
// stalls. A due NEED_DECISION consults the provider-pressure ledger
// (providerPressureOf): a pressure pause or canary probe in flight slides
// the branch's window (since = now) instead of paging the owner; the
// absolute backstop (from the immutable first-seen) still escalates after
// 48h total; legacy rows without first-seen default first to since.
import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteStuckDefer } from "../hooks/lib/fleet-loop/ladder-repair.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";

const REPO = join(import.meta.dir, "..");

const store = () => {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT); CREATE TABLE facts(key TEXT PRIMARY KEY, value TEXT)",
	);
	return db;
};

const pressure = (db: Database, value: unknown): void => {
	db.query(
		"INSERT OR REPLACE INTO facts(key, value) VALUES('review.provider.pressure', ?)",
	).run(JSON.stringify(value));
};

const eventCount = (db: Database): number =>
	(db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;

const defer = (
	file: string,
	db: Database,
	branch: string,
	item: string,
	why: string,
	now: number,
): boolean =>
	noteStuckDefer(REPO, branch, item, why, {
		file,
		db: db as unknown as GovernorStore,
		maxAgeMs: 1000,
		now,
	});

test.describe("W2978 transport-stall classification @unit", () => {
	test("pressure pause slides the window; healing raises at the next boundary", () => {
		const db = store();
		const file = join(mkdtempSync(join(tmpdir(), "w2978-")), "stuck.json");
		const b = "suspenders/W8";
		pressure(db, { fails: 2, openUntil: 2500, updated: 0 });
		expect(defer(file, db, b, "W8", "review required: a", 0)).toBe(false);
		// Due (age ≥ maxAge) while the pause is open: slid, never paged.
		expect(defer(file, db, b, "W8", "review required: b", 2000)).toBe(false);
		const row = JSON.parse(readFileSync(file, "utf8"))[b] as {
			since: number;
		};
		expect(row.since).toBe(2000);
		expect(eventCount(db)).toBe(0);
		// Transport heals (openUntil in the past): the slid window raises.
		pressure(db, { fails: 0, openUntil: 0, updated: 2000 });
		expect(defer(file, db, b, "W8", "review required: c", 3000)).toBe(true);
		expect(eventCount(db)).toBe(1);
		// Once raised, later defers stay silent.
		expect(defer(file, db, b, "W8", "review required: d", 5000)).toBe(false);
	});

	test("canary probe in flight slides the window too", () => {
		const db = store();
		const file = join(mkdtempSync(join(tmpdir(), "w2978-")), "stuck.json");
		const b = "suspenders/W9";
		pressure(db, {
			fails: 0,
			openUntil: 0,
			updated: 0,
			probe: { key: "glm-5.3-flash", until: 3000 },
		});
		expect(defer(file, db, b, "W9", "review required: a", 0)).toBe(false);
		// Due under the probe hold: slid, never paged.
		expect(defer(file, db, b, "W9", "review required: b", 2000)).toBe(false);
		expect(eventCount(db)).toBe(0);
		expect(
			(JSON.parse(readFileSync(file, "utf8"))[b] as { since: number }).since,
		).toBe(2000);
	});

	test("a never-healing stall still raises at the absolute backstop", () => {
		const db = store();
		const file = join(mkdtempSync(join(tmpdir(), "w2978-")), "stuck.json");
		const b = "suspenders/W10";
		pressure(db, {
			fails: 9,
			openUntil: Number.MAX_SAFE_INTEGER,
			updated: 0,
		});
		const hour = 3_600_000;
		expect(defer(file, db, b, "W10", "review required: a", 0)).toBe(false);
		// 47h total: stalled, inside the backstop → slid again, silent.
		expect(defer(file, db, b, "W10", "review required: b", 47 * hour)).toBe(
			false,
		);
		expect(eventCount(db)).toBe(0);
		// 48h total: the backstop escalates despite the open pause.
		expect(defer(file, db, b, "W10", "review required: c", 48 * hour)).toBe(
			true,
		);
		expect(eventCount(db)).toBe(1);
	});

	test("legacy rows without first-seen default first to since", () => {
		const db = store();
		const file = join(mkdtempSync(join(tmpdir(), "w2978-")), "stuck.json");
		const b = "suspenders/W11";
		writeFileSync(
			file,
			JSON.stringify({ [b]: { since: 0, why: "review required: old" } }),
		);
		// Healthy transport: raises as before; first inherits since.
		expect(defer(file, db, b, "W11", "review required: new", 1000)).toBe(true);
		const row = JSON.parse(readFileSync(file, "utf8"))[b] as {
			first?: number;
			raised?: boolean;
		};
		expect(row.first).toBe(0);
		expect(row.raised).toBe(true);
	});
});
