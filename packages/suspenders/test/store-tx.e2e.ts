// test/store-tx.test.ts — W662: beginWithHeal (store-server tx desync heal).
// A null marker with the connection actually inside a transaction made every
// tx-mode begin throw "within a transaction" → unhandled → HTTP 500 →
// work add/done/split dead fleet-wide until restart. The server's tx state is
// process-local, so these drive the state machine through a stub connection.
import { expect, test } from "./pw";
import {
	beginWithHeal,
	sweepOrphanTxn,
	sweepStaleTxn,
	type TxCell,
} from "../hooks/lib/knowledge/store-tx.ts";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";

// beginFails scripts failures for BEGIN IMMEDIATE calls in order (other
// statements never consume from it); log records every statement issued.
const makeConn = (beginFails: string[], log: string[]): GovernorStore =>
	({
		run(sql: string) {
			log.push(sql);
			if (sql === "BEGIN IMMEDIATE" && beginFails.length)
				throw new Error(beginFails.shift());
			return { changes: 0, lastInsertRowid: 0 };
		},
	}) as unknown as GovernorStore;

test.describe("beginWithHeal (W662 tx desync)", () => {
	test("fresh begin issues BEGIN IMMEDIATE once", () => {
		const log: string[] = [];
		expect(beginWithHeal(makeConn([], log))).toEqual({ ok: true });
		expect(log).toEqual(["BEGIN IMMEDIATE"]);
	});

	test("marker-null desync: orphan rollback + re-begin", () => {
		const log: string[] = [];
		const conn = makeConn(
			["SqliteError: cannot start a transaction within a transaction"],
			log,
		);
		expect(beginWithHeal(conn)).toEqual({ ok: true });
		expect(log).toEqual(["BEGIN IMMEDIATE", "ROLLBACK", "BEGIN IMMEDIATE"]);
	});

	test("non-desync begin failure returns {err} without touching the conn", () => {
		const log: string[] = [];
		const r = beginWithHeal(makeConn(["SqliteError: database is locked"], log));
		expect(r.err).toContain("begin failed");
		expect(r.err).toContain("database is locked");
		expect(log).toEqual(["BEGIN IMMEDIATE"]);
	});

	test("heal reports failure when the re-begin also fails", () => {
		const log: string[] = [];
		const r = beginWithHeal(
			makeConn(
				[
					"SqliteError: cannot start a transaction within a transaction",
					"SqliteError: database is locked",
				],
				log,
			),
		);
		expect(r.err).toContain("begin failed");
		expect(r.err).toContain("database is locked");
		expect(log).toEqual(["BEGIN IMMEDIATE", "ROLLBACK", "BEGIN IMMEDIATE"]);
	});
});

test.describe("sweepStaleTxn (W978 stale write-txn watchdog)", () => {
	const cellWith = (id: string, started: number): TxCell => ({
		v: { id, last: started, started },
	});

	test("clean cell: no-op", () => {
		const log: string[] = [];
		const cell: TxCell = { v: null };
		expect(
			sweepStaleTxn({ label: "governor", cell, txConn: makeConn([], log) }),
		).toBeNull();
		expect(log).toEqual([]);
	});

	test("window under max age survives untouched", () => {
		const log: string[] = [];
		const cell = cellWith("tx1", 1000);
		expect(
			sweepStaleTxn({
				label: "governor",
				cell,
				txConn: makeConn([], log),
				maxAgeMs: 1000,
				now: 1500,
			}),
		).toBeNull();
		expect(cell.v).toEqual({ id: "tx1", last: 1000, started: 1000 });
	});
});

test.describe("sweepStaleTxn abort path (W978)", () => {
	test("window over max age: rollback + clear + event", () => {
		const log: string[] = [];
		const cell: TxCell = { v: { id: "tx1", last: 1000, started: 1000 } };
		const e = sweepStaleTxn({
			label: "governor",
			cell,
			txConn: makeConn([], log),
			maxAgeMs: 1000,
			now: 2001,
		});
		expect(e).toEqual({
			plane: "governor",
			txid: "tx1",
			ageMs: 1001,
			reason: "stale",
		});
		expect(log).toEqual(["ROLLBACK"]);
		expect(cell.v).toBeNull();
	});
});

test.describe("sweepOrphanTxn (W978 orphan probe)", () => {
	test("conn outside a txn: probe begins + releases, no event", () => {
		const log: string[] = [];
		expect(
			sweepOrphanTxn({ label: "governor", conn: makeConn([], log) }),
		).toBeNull();
		expect(log).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
	});
});

test.describe("sweepOrphanTxn abort path (W978)", () => {
	test("untracked orphan write txn: rolled back + event", () => {
		const log: string[] = [];
		const conn = makeConn(
			["SqliteError: cannot start a transaction within a transaction"],
			log,
		);
		const e = sweepOrphanTxn({ label: "identity", conn });
		expect(e).toEqual({
			plane: "identity",
			txid: null,
			ageMs: 0,
			reason: "orphan",
		});
		expect(log).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
	});

	test("external write lock: nothing of ours to abort", () => {
		const log: string[] = [];
		const conn = makeConn(["SqliteError: database is locked"], log);
		expect(sweepOrphanTxn({ label: "governor", conn })).toBeNull();
		expect(log).toEqual(["BEGIN IMMEDIATE"]);
	});
});
