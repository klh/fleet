// W635 — lane-spend attribution tests: ledger resolution, spend extraction,
// claim-window join. In-memory/temp ledger, real functions.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	itemAttribution,
	itemRequestSpendSeries,
	itemSpend,
	itemSpendSeries,
	laneRequestSpendRows,
	laneSpendRows,
	resolveBuckleDb,
	type LaneSpendRow,
} from "./lane-spend.ts";
import type { ClaimWindow } from "./work-timing.ts";

const T0 = 1_700_000_000_000;

function row(p: Partial<LaneSpendRow>): LaneSpendRow {
	return {
		bucket: "2026-10-06T18:00",
		sid: "autow1-x",
		group: "glm-5.3-flash",
		inTok: 0,
		outTok: 0,
		cacheR: 0,
		cacheC: 0,
		requests: 1,
		...p,
	};
}

describe("itemSpend", () => {
	const wins = new Map<string, ClaimWindow[]>([
		["W1", [{ sid: "s1", start: T0, end: T0 + 3_600_000 }]],
	]);

	test("attributes buckets inside the window, splits by group", () => {
		const m = itemSpend(
			[
				row({
					bucket: "2023-11-14T23:00",
					sid: "s1",
					inTok: 100,
					outTok: 10,
				}),
				row({
					bucket: "2023-11-14T23:00",
					sid: "s2",
					group: "gpt-5.2",
					inTok: 7,
				}),
			],
			wins,
		);
		const w1 = m.get("W1");
		expect(w1?.in).toBe(100);
		expect(w1?.out).toBe(10);
		expect(w1?.groups.get("glm-5.3-flash")?.in).toBe(100);
		expect(m.get("W2")?.in ?? 0).toBe(0); // W2 unattributed here
	});

	test("buckets outside every window are never attributed", () => {
		const m = itemSpend(
			[row({ bucket: "2023-11-15T02:00", inTok: 500 })],
			wins,
		);
		expect(m.get("W1")?.in).toBe(0);
	});

	test("re-claims sum their windows", () => {
		const wins2 = new Map<string, ClaimWindow[]>([
			[
				"W3",
				[
					{ sid: "s1", start: T0, end: T0 + 600_000 },
					{ sid: "s1", start: T0 + 600_000, end: T0 + 1_200_000 },
				],
			],
		]);
		const m = itemSpend(
			[
				row({ bucket: "2023-11-14T22:00", sid: "s1", inTok: 50 }),
				row({ bucket: "2023-11-14T22:00", sid: "s1", inTok: 30 }),
			],
			wins2,
		);
		expect(m.get("W3")?.in).toBe(80);
	});

	test("firstBucket tracks the earliest attributed bucket (W943.1)", () => {
		const m = itemSpend(
			[
				row({ bucket: "2023-11-14T22:00", sid: "s1", inTok: 50 }),
				row({ bucket: "2023-11-14T23:00", sid: "s1", inTok: 30 }),
			],
			wins,
		);
		expect(m.get("W1")?.firstBucket).toBe("2023-11-14T22:00");
	});

	test("firstBucket stays null when nothing attributes (W943.1)", () => {
		const m = itemSpend(
			[row({ bucket: "2023-11-15T02:00", sid: "s2", inTok: 500 })],
			wins,
		);
		expect(m.get("W1")?.firstBucket ?? null).toBeNull();
	});
});

describe("itemSpendSeries (W887)", () => {
	const wins = new Map<string, ClaimWindow[]>([
		["W1", [{ sid: "s1", start: T0, end: T0 + 3_600_000 }]],
	]);

	test("per-bucket points oldest-first, cached = cacheR + cacheC", () => {
		const pts = itemSpendSeries(
			[
				row({ bucket: "2023-11-14T22:00", sid: "s1", inTok: 50, cacheR: 20 }),
				row({
					bucket: "2023-11-14T23:00",
					sid: "s1",
					inTok: 70,
					cacheC: 10,
					outTok: 5,
				}),
			],
			wins,
		).get("W1");
		expect(pts?.length).toBe(2);
		expect(pts?.[0]).toEqual({
			t: Date.parse("2023-11-14T22:00:00Z"),
			fresh: 50,
			cached: 20,
			out: 0,
		});
		expect(pts?.[1]).toEqual({
			t: Date.parse("2023-11-14T23:00:00Z"),
			fresh: 70,
			cached: 10,
			out: 5,
		});
	});

	test("cap keeps the newest buckets, drops the oldest", () => {
		const pts = itemSpendSeries(
			[
				row({ bucket: "2023-11-14T21:00", sid: "s1", inTok: 1 }),
				row({ bucket: "2023-11-14T22:00", sid: "s1", inTok: 2 }),
				row({ bucket: "2023-11-14T23:00", sid: "s1", inTok: 3 }),
			],
			wins,
			2,
		).get("W1");
		expect(pts?.length).toBe(2);
		expect(pts?.[0]?.fresh).toBe(2);
		expect(pts?.[1]?.fresh).toBe(3);
	});

	test("buckets outside every window never appear in the series", () => {
		const pts = itemSpendSeries(
			[row({ bucket: "2023-11-15T02:00", sid: "s1", inTok: 500 })],
			wins,
		).get("W1");
		expect(pts?.length ?? 0).toBe(0);
	});
});

describe("recent request spend series", () => {
	test("reads per-request usage and attributes exact claim windows into one-minute points", () => {
		const dir = mkdtempSync(join(tmpdir(), "fleet-lane-spark-"));
		const file = join(dir, "buckle.db");
		try {
			const db = new Database(file);
			db.run(
				"CREATE TABLE route_audit (ts TEXT, lane TEXT, in_tok INTEGER, out_tok INTEGER, cache_r INTEGER, cache_c INTEGER)",
			);
			const insert = db.query(
				"INSERT INTO route_audit VALUES (?, ?, ?, ?, ?, ?)",
			);
			const base = Date.parse("2026-10-19T20:00:00Z");
			insert.run(new Date(base + 10_000).toISOString(), "lane-a", 20, 2, 30, 0);
			insert.run(new Date(base + 40_000).toISOString(), "lane-a", 10, 1, 0, 5);
			insert.run(new Date(base + 70_000).toISOString(), "lane-a", 40, 4, 20, 0);
			insert.run(new Date(base + 130_000).toISOString(), "lane-a", 99, 9, 0, 0);
			insert.run(
				new Date(base + 75_000).toISOString(),
				"other-lane",
				500,
				0,
				0,
				0,
			);
			db.close();
			const rows = laneRequestSpendRows(file, "2026-10-19T20:00:00Z");
			const windows = new Map<string, ClaimWindow[]>([
				["W1", [{ sid: "lane-a", start: base, end: base + 120_000 }]],
				["W2", [{ sid: "lane-a", start: base + 120_000, end: base + 180_000 }]],
			]);
			const series = itemRequestSpendSeries(rows, windows);
			expect(series.get("W1")).toEqual([
				{ t: base, fresh: 30, cached: 35, out: 3 },
				{ t: base + 60_000, fresh: 40, cached: 20, out: 4 },
			]);
			expect(series.get("W2")).toEqual([
				{ t: base + 120_000, fresh: 99, cached: 0, out: 9 },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("laneSpendRows + resolveBuckleDb", () => {
	test("reads hour buckets from a real sqlite ledger", () => {
		const p = `${import.meta.dir}/w635-ledger-probe.db`;
		try {
			unlinkSync(p);
		} catch {}
		const e = new Database(p);
		e.run("DROP TABLE IF EXISTS api_keys");
		e.run("DROP TABLE IF EXISTS router_usage");
		e.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
		e.run(
			"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, model TEXT DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0)",
		);
		e.run("INSERT INTO api_keys VALUES ('k1', 'autow9-x')");
		e.run(
			"INSERT INTO router_usage VALUES ('2026-10-06T18:00','k1','glm-5.3-flash','glm-5.3-flash',10,5,0,0,2)",
		);
		e.close();
		const rows = laneSpendRows(p, "2026-10-01T00:00");
		expect(rows.length).toBe(1);
		expect(rows[0]).toMatchObject({
			sid: "autow9-x",
			group: "glm-5.3-flash",
			inTok: 10,
			outTok: 5,
			requests: 2,
		});
	});

	test("resolveBuckleDb: env pin wins, then spoke home, else null", () => {
		process.env.SUSPENDERS_BUCKLE_DB = "/nonexistent-w635.db";
		expect(resolveBuckleDb("/nonexistent-home")).toBeNull();
		delete process.env.SUSPENDERS_BUCKLE_DB;
		expect(resolveBuckleDb("/nonexistent-home")).toBeNull();
	});
});

// W776 — itemAttribution fixtures: governor-shaped events db + ledger-shaped
// spend db, both in-memory; the full join verified end-to-end.
const WT0 = 1_700_000_000_000;

function attrGovDb(): Database {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
	);
	d.run(
		"INSERT INTO events (ts, kind, project, payload) VALUES (?, 'work.claimed', 'proj', ?)",
		[WT0, JSON.stringify({ work: "W1", by: "s1" })],
	);
	d.run(
		"INSERT INTO events (ts, kind, project, payload) VALUES (?, 'work.done', 'proj', ?)",
		[WT0 + 30 * 60_000, JSON.stringify({ work: "W1" })],
	);
	d.run(
		"INSERT INTO events (ts, kind, project, payload) VALUES (?, 'work.claimed', 'proj', ?)",
		[WT0 + 40 * 60_000, JSON.stringify({ work: "W2", by: "s1" })],
	);
	return d;
}

// W1070 — subagent-run item: no ledger rows attribute, the work.done payload
// carries the closing session's self-reported spend stamp instead.
function attrSubagentDb(): Database {
	const d = new Database(":memory:");
	d.run(
		"CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, project TEXT, payload TEXT)",
	);
	d.run(
		"INSERT INTO events (ts, kind, project, payload) VALUES (?, 'work.claimed', 'proj', ?)",
		[WT0, JSON.stringify({ work: "W9", by: "s1" })],
	);
	d.run(
		"INSERT INTO events (ts, kind, project, payload) VALUES (?, 'work.done', 'proj', ?)",
		[
			WT0 + 20 * 60_000,
			JSON.stringify({
				work: "W9",
				spendFresh: 1500,
				spendCached: 96_000,
				spendOut: 2400,
				spendModel: "glm-5.3-flash",
			}),
		],
	);
	return d;
}

function attrLedgerDb(path = ":memory:"): Database {
	const d = new Database(path);
	d.run("CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, name TEXT)");
	d.run(
		"CREATE TABLE router_usage (hour_bucket TEXT, key TEXT, model_group TEXT, model TEXT DEFAULT '', in_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, cache_r INTEGER DEFAULT 0, cache_c INTEGER DEFAULT 0, requests INTEGER DEFAULT 0)",
	);
	d.run("INSERT INTO api_keys VALUES ('k1', 's1')");
	d.run(
		"INSERT INTO router_usage VALUES ('2023-11-14T22:00','k1','glm-5.3-flash','glm-5.3-flash',120,40,20,10,3)",
	);
	d.run(
		"INSERT INTO router_usage VALUES ('2023-11-14T20:00','k1','glm-5.5','glm-5.5',999,0,0,0,1)",
	);
	return d;
}

describe("itemAttribution", () => {
	test("joins spend + wall end-to-end from real dbs", () => {
		const lp = `${import.meta.dir}/w776-ledger-probe.db`;
		try {
			unlinkSync(lp);
		} catch {}
		attrLedgerDb(lp).close();
		const now = WT0 + 45 * 60_000;
		const m = itemAttribution(attrGovDb(), "proj", now, lp);
		const a1 = m.get("W1");
		expect(a1?.fresh).toBe(120);
		expect(a1?.cached).toBe(30);
		expect(a1?.out).toBe(40);
		expect(a1?.requests).toBe(3);
		expect(a1?.wallMs).toBe(30 * 60_000);
		expect(a1?.agentMs).toBe(30 * 60_000);
		expect(a1?.blindCache).toBe(true);
		expect(a1?.groups["glm-5.3-flash"]?.in).toBe(120);
		const a2 = m.get("W2");
		expect(a2?.fresh ?? 0).toBe(0);
		expect(a2?.agentMs).toBe(5 * 60_000);
	});

	test("W943.1: SUSPENDERS_CACHE_ERA_FIX pins the era (false case)", () => {
		const lp = `${import.meta.dir}/w9431-era-probe.db`;
		try {
			unlinkSync(lp);
		} catch {}
		attrLedgerDb(lp).close();
		process.env.SUSPENDERS_CACHE_ERA_FIX = "2023-11-14T19:00";
		try {
			const m = itemAttribution(attrGovDb(), "proj", WT0 + 45 * 60_000, lp);
			expect(m.get("W1")?.blindCache).toBe(false);
		} finally {
			delete process.env.SUSPENDERS_CACHE_ERA_FIX;
		}
	});

	test("missing ledger fails soft: zero spend, real wall", () => {
		const m = itemAttribution(attrGovDb(), "proj", WT0 + 45 * 60_000, null);
		const a1 = m.get("W1");
		expect(a1?.fresh).toBe(0);
		expect(a1?.wallMs).toBe(30 * 60_000);
	});

	// W1070: subagent-run work — ledger attributes zero, the done-payload
	// spend stamp stands in (fresh/cached/out + one named model group).
	test("done-payload spend stamps in as fallback when no ledger rows attribute", () => {
		const m = itemAttribution(
			attrSubagentDb(),
			"proj",
			WT0 + 25 * 60_000,
			null,
		);
		const a9 = m.get("W9");
		expect(a9?.fresh).toBe(1500);
		expect(a9?.cached).toBe(96_000);
		expect(a9?.out).toBe(2400);
		expect(a9?.groups["glm-5.3-flash"]?.in).toBe(1500);
		expect(a9?.groups["glm-5.3-flash"]?.cacheR).toBe(96_000);
		expect(a9?.wallMs).toBe(20 * 60_000);
		// ledger spend wins when it attributes — the stamp never double-counts
		const lp = `${import.meta.dir}/w1070-ledger-probe.db`;
		try {
			unlinkSync(lp);
		} catch {}
		attrLedgerDb(lp).close();
		const withLedger = itemAttribution(
			attrSubagentDb(),
			"proj",
			WT0 + 45 * 60_000,
			lp,
		);
		// W9's window overlaps s1's keyed 22:00 bucket — ledger rows win, the
		// stamp is ignored (fresh 120 from the ledger, not the 1500 stamp)
		expect(withLedger.get("W9")?.fresh).toBe(120);
		expect(withLedger.get("W9")?.cached).toBe(30);
	});
});
