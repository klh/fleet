// W635 — lane-spend attribution tests: ledger resolution, spend extraction,
// claim-window join. In-memory/temp ledger, real functions.
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	itemSpend,
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
