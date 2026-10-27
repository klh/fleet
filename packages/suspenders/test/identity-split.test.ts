// test/identity-split.test.ts — W359 (W156 port): the v17 identity split.
// Covers the copy path (identity rows move governor→identity.db with
// auth_events ids preserved), the DROP on the governor side, the pre-split
// VACUUM INTO backup, the idb-wins reset path, the split-brain refusal, and
// the identitySqlViolation /rpc guard.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-identity-split-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?idsplit=${encodeURIComponent(HOME)}`
);
const { IDENTITY_DDL, identitySqlViolation } = await import(
	"../hooks/lib/govdb/identity-db.ts"
);
process.env.HOME = REAL_HOME;

const DB = join(HOME, ".cache", "claude-governor", "governor.db");
const IDB = join(HOME, ".cache", "claude-governor", "identity.db");

// a pre-split governor: current-code open, then identity tables seeded via
// the DDL (idb. prefix stripped) and the version pinned BELOW the split
function preSplitDb(uv: number): Database {
	mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });
	const db = new Database(DB, { create: true });
	for (const stmts of Object.values(IDENTITY_DDL))
		for (const s of stmts) db.exec(s.replaceAll("idb.", ""));
	db.run(`PRAGMA user_version = ${uv}`);
	db.close();
	return new Database(DB);
}

describe("v17 identity split — copy path", () => {
	test("rows move governor to identity.db, auth_events ids preserved, backup minted", () => {
		const db = preSplitDb(16);
		db.exec(
			"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('k1', 'sha256:x', 1)",
		);
		db.exec(
			"INSERT INTO auth_events (ts, actor, event) VALUES (1, 'klh', 'issued')",
		);
		db.exec(
			"INSERT INTO teams (team_id, name, created_at) VALUES ('t1', 'Platform', 1)",
		);
		db.close();
		const db2 = govdb.openGovernorDb();
		const uv = (
			db2.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		// the split stamps 17 mid-ladder; later steps (v18/v19) keep climbing
		expect(uv).toBeGreaterThanOrEqual(17);
		const idb = new Database(IDB);
		const k = idb
			.query("SELECT key_id FROM api_keys WHERE key_id = 'k1'")
			.get();
		expect(k).not.toBeNull();
		const ev = idb.query("SELECT id FROM auth_events").get() as { id: number };
		expect(ev.id).toBe(1);
		const t = idb.query("SELECT name FROM teams WHERE team_id = 't1'").get();
		expect(t).not.toBeNull();
		const gone = (
			db2
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'",
				)
				.get() as { n: number }
		).n;
		expect(gone).toBe(0);
		const dir = join(HOME, ".cache", "claude-governor");
		const baks = readdirSync(dir).filter((f) =>
			f.startsWith("governor-pre-identity-split-"),
		);
		expect(baks.length).toBeGreaterThan(0);
		idb.close();
		db2.close();
	});
});
describe("v17 identity split — guards", () => {
	test("split-brain refusal: both files holding identity rows refuses loudly", () => {
		const db = preSplitDb(16);
		db.exec(
			"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('k2', 'h', 1)",
		);
		db.close();
		// idb holds k1 from the copy-path test — both sides populated
		expect(() => govdb.openGovernorDb()).toThrow(/both hold identity rows/);
	});
});
describe("v17 identity split — reset path", () => {
	test("idb-wins reset: populated identity.db + empty governor keeps idb rows", () => {
		const db = preSplitDb(16);
		db.exec("DELETE FROM api_keys");
		db.exec("DELETE FROM auth_events");
		db.exec("DELETE FROM teams");
		db.close();
		const db2 = govdb.openGovernorDb();
		const idb = new Database(IDB);
		const n = (
			idb.query("SELECT COUNT(*) AS n FROM api_keys").get() as { n: number }
		).n;
		expect(n).toBe(1); // k1 rode the reset untouched
		const idbN = (
			db2
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'api_keys'",
				)
				.get() as { n: number }
		).n;
		expect(idbN).toBe(0);
		idb.close();
		db2.close();
	});
});
describe("identitySqlViolation — the /rpc guard", () => {
	test("flags the identity set, spares occurrences inside string literals", () => {
		expect(identitySqlViolation("SELECT * FROM api_keys")).toBe("api_keys");
		expect(identitySqlViolation("select name from teams")).toBe("teams");
		expect(identitySqlViolation("UPDATE auth_events SET via = 'x'")).toBe(
			"auth_events",
		);
		expect(identitySqlViolation("DELETE FROM ceilings")).toBe("ceilings");
		expect(identitySqlViolation("SELECT 1 FROM users")).toBe("users");
		expect(
			identitySqlViolation("SELECT 1 FROM deltas WHERE tbl = 'api_keys'"),
		).toBeNull();
		expect(
			identitySqlViolation(
				"SELECT 1 FROM events WHERE payload LIKE '%api_keys.%'",
			),
		).toBeNull();
	});
});

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});
