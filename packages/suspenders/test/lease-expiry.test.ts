import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expireObservedLease } from "../hooks/lib/lease-expiry.ts";
import type { GovernorStore } from "../hooks/lib/govdb.ts";

test("same-owner renewal in another SQLite connection survives stale expiry observation", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-lease-expiry-"));
	try {
		const path = join(root, "private.db");
		const expiry = new Database(path),
			renewal = new Database(path);
		expiry.run("PRAGMA journal_mode=WAL");
		expiry.run("CREATE TABLE locks(path TEXT PRIMARY KEY,sid TEXT,ts INTEGER)");
		expiry.query("INSERT INTO locks VALUES ('file','owner',1)").run();
		const observed = expiry.query("SELECT path,sid,ts FROM locks").get() as {
			path: string;
			sid: string;
			ts: number;
		};
		renewal
			.query("UPDATE locks SET ts=1001 WHERE path='file' AND sid='owner'")
			.run();
		expect(
			expireObservedLease(
				expiry as unknown as GovernorStore,
				observed,
				1001,
				100,
			),
		).toBe(false);
		expect(expiry.query("SELECT * FROM locks").get()).toEqual({
			path: "file",
			sid: "owner",
			ts: 1001,
		});
		expiry.close();
		renewal.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("expiry removes only the exact observed stale generation and honors the TTL boundary", () => {
	const db = new Database(":memory:");
	db.run("CREATE TABLE locks(path TEXT PRIMARY KEY,sid TEXT,ts INTEGER)");
	db.query("INSERT INTO locks VALUES ('file','new-owner',1)").run();
	const store = db as unknown as GovernorStore;
	expect(
		expireObservedLease(
			store,
			{ path: "file", sid: "old-owner", ts: 1 },
			102,
			100,
		),
	).toBe(false);
	expect(
		expireObservedLease(
			store,
			{ path: "file", sid: "new-owner", ts: 1 },
			101,
			100,
		),
	).toBe(false);
	expect(
		expireObservedLease(
			store,
			{ path: "file", sid: "new-owner", ts: 1 },
			102,
			100,
		),
	).toBe(true);
	expect(
		expireObservedLease(
			store,
			{ path: "file", sid: "new-owner", ts: 1 },
			102,
			100,
		),
	).toBe(false);
	db.close();
});

test("failed store expiry cannot report lease removal or switch to another store", () => {
	const unavailable = {
		query: () => {
			throw new Error("authoritative lease operation unavailable");
		},
	} as unknown as GovernorStore;
	expect(() =>
		expireObservedLease(
			unavailable,
			{ path: "file", sid: "owner", ts: 1 },
			102,
			100,
		),
	).toThrow("authoritative lease operation unavailable");
});
