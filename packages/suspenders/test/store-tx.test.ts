// test/store-tx.test.ts — W662: beginWithHeal (store-server tx desync heal).
// A null marker with the connection actually inside a transaction made every
// tx-mode begin throw "within a transaction" → unhandled → HTTP 500 →
// work add/done/split dead fleet-wide until restart. The server's tx state is
// process-local, so these drive the state machine through a stub connection.
import { describe, expect, test } from "bun:test";
import { beginWithHeal } from "../hooks/lib/store-tx.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

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

describe("beginWithHeal (W662 tx desync)", () => {
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
