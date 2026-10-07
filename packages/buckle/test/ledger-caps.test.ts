// test/ledger-caps.test.ts — W450 pending-entry/byte caps: overflow sheds
// the OLDEST row, every drop is counted, flush failures keep bytes honest.
import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger.ts";

const rec = (n: number, pad = "") => ({
	key: pad,
	group: `g${n}`,
	model: "m",
	in_tok: 1,
	out_tok: 1,
	cache_r: 0,
	cache_c: 0,
	requests: 1,
});

describe("ledger ring caps (W450)", () => {
	test("entry cap sheds the oldest usage row and counts it", () => {
		const dropped: Array<[string, number]> = [];
		const db = new Ledger(":memory:", undefined, {
			maxPendingEntries: 2,
			onDrop: (k, n) => dropped.push([k, n]),
		});
		db.record(rec(1));
		db.record(rec(2));
		db.record(rec(3)); // shed rec(1)
		expect(db.pending()).toBe(2);
		expect(db.dropped).toBe(1);
		expect(dropped).toEqual([["usage", 1]]);
		const rows = db.rows(); // flushes
		expect(rows.map((r) => r.model_group)).toEqual(["g2", "g3"]);
		db.close();
	});

	test("byte cap sheds oldest audit ops when err strings balloon", () => {
		const db = new Ledger(":memory:", undefined, { maxPendingBytes: 256 });
		for (let i = 0; i < 5; i++)
			db.auditOutcome(`r${String(i)}`, {
				status: 502,
				duration_ms: 1,
				ok: false,
				err: "x".repeat(100), // ~166B estimate each → two fit the 256B cap
			});
		expect(db.pending()).toBe(1);
		expect(db.dropped).toBe(4);
		expect(db.pendingBytes()).toBeLessThanOrEqual(264);
		db.close();
	});

	test("flush failure requeues survivors with honest byte counts", () => {
		const db = new Ledger(":memory:", undefined, { maxPendingEntries: 8 });
		db.record(rec(1));
		db.record(rec(2));
		// break the db so the flush transaction throws
		(db as unknown as { db: { exec: (s: string) => void } }).db.exec(
			"DROP TABLE router_usage",
		);
		db.flush();
		expect(db.flushFails).toBe(1);
		expect(db.pending()).toBe(2);
		expect(db.pendingBytes()).toBeGreaterThan(0);
		db.close();
	});

	test("defaults are bounded without options", () => {
		const db = new Ledger(":memory:");
		db.record(rec(1));
		expect(db.pendingBytes()).toBeGreaterThan(0);
		expect(db.dropped).toBe(0);
		db.close();
	});
});
