// govdb-router-tables.test.ts — W132: the v8 router governance tables exist
// with the W131/W136/W137 shapes, ride the existing deltas trigger loop with
// zero per-table wiring (the audit trail IS the deltas log), and honor the
// two write contracts the router leans on: aid_rollup UPSERT-ADD (W137 §6 —
// flushers add, never overwrite) and budget_state upsert-add flush (W135 —
// a retried batch never loses counts). api_keys carries the token mechanics
// (access|refresh, parent_key_id rotation chain, jti denylist, NULL
// expires_at = forever) and stores HASHES only. Temp-HOME isolation per the
// govdb-migration recipe: the ?query import busts bun's shared module cache
// so this file's govdb instance binds the temp HOME, never the real
// governor.db. HOME is restored right after import — REG is captured at
// module load, so later imports in other files rebind to the real HOME.

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-w132-"));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME; // REG binds at govdb module load — set before import
const { openGovernorDb } = await import(
	`../hooks/lib/govdb/govdb.ts?w132=${encodeURIComponent(HOME)}`
);
process.env.HOME = REAL_HOME;
// W359: v8 shipped api_keys/auth_events — a pre-split fixture must carry
// them; post-split their DDL lives in identity-db.ts (strip its idb. prefix)
const { IDENTITY_DDL } = await import("../hooks/lib/govdb/identity-db.ts");

const DB = `${HOME}/.cache/claude-governor/governor.db`;
const IDB = `${HOME}/.cache/claude-governor/identity.db`;

function freshDb(): Database {
	mkdirSync(dirname(DB), { recursive: true });
	// W156: the identity file splits from governor.db — a fresh fixture
	// resets BOTH planes so the v17 copy path starts from a clean idb
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(DB + suffix, { force: true });
		rmSync(IDB + suffix, { force: true });
	}
	return new Database(DB, { create: true });
}

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const NEW_TABLES: Record<string, string[]> = {
	api_keys: [
		"key_id",
		"key_hash",
		"jti",
		"name",
		"team",
		"actor",
		"token_type",
		"parent_key_id",
		"scopes",
		"rpm_limit",
		"tpm_limit",
		"expires_at",
		"rotated_at",
		"revoked_at",
		"created_at",
	],
	teams: [
		"team_id",
		"name",
		"department",
		"created_at",
		"rpm_ceiling",
		"tpm_ceiling",
		"tok_ceiling",
	],
	route_audit: [
		"rid",
		"ts",
		"actor",
		"dialect",
		"hint",
		"candidates",
		"resolved_target",
		"decision",
		"latency_class",
		"error_code",
	],
	aid_events: [
		"id",
		"ts",
		"sid",
		"work_item",
		"aid",
		"packet_id",
		"tokens_injected",
		"est_tok_saved",
	],
	aid_rollup: [
		"hour_bucket",
		"aid",
		"domain",
		"model_group",
		"injected",
		"skipped",
		"tok_injected",
		"est_tok_saved",
		"requests",
	],
	budget_state: ["key_id", "window", "used_rpm", "used_tpm", "window_start"],
	auth_events: ["id", "ts", "actor", "event", "jti", "via"],
};

// W359 (W156): the identity set (api_keys/teams/auth_events) moved to
// identity.db at v17 — the file-split assertion set. users/ceilings stay
// reserved names with no schema ever shipped.
const IDENTITY_MOVED = ["api_keys", "teams", "auth_events"] as const;
const GOV_TABLES: Record<string, string[]> = Object.fromEntries(
	Object.entries(NEW_TABLES).filter(
		([t]) => !(IDENTITY_MOVED as readonly string[]).includes(t),
	),
);
const IDB_TABLES: Record<string, string[]> = Object.fromEntries(
	Object.entries(NEW_TABLES).filter(([t]) =>
		(IDENTITY_MOVED as readonly string[]).includes(t),
	),
);

const DML = {
	rollupAdd: `INSERT INTO aid_rollup (hour_bucket, aid, domain, model_group, injected, skipped, tok_injected, est_tok_saved, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (hour_bucket, aid, domain, model_group) DO UPDATE SET
	injected = injected + excluded.injected,
	skipped = skipped + excluded.skipped,
	tok_injected = tok_injected + excluded.tok_injected,
	est_tok_saved = est_tok_saved + excluded.est_tok_saved,
	requests = requests + excluded.requests`,
	budgetFlush: `INSERT INTO budget_state (key_id, window, used_rpm, used_tpm, window_start) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (key_id, window) DO UPDATE SET
	used_rpm = used_rpm + excluded.used_rpm,
	used_tpm = used_tpm + excluded.used_tpm,
	window_start = excluded.window_start`,
};

// W137 §6 SQL verbatim — the W132 boundary declared this exact shape
const DOC_AID_ROLLUP_SQL = `CREATE TABLE IF NOT EXISTS aid_rollup (
  hour_bucket INTEGER NOT NULL,
  aid TEXT NOT NULL,
  domain TEXT NOT NULL,
  model_group TEXT NOT NULL,
  injected INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  tok_injected INTEGER NOT NULL DEFAULT 0,
  est_tok_saved INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_bucket, aid, domain, model_group)
);`;

test.describe("v8 migration shape", () => {
	test("user_version >= 17 (the identity split rides the ladder tail), the four control-plane router tables present, the identity set moved to identity.db with the designed columns", () => {
		const db = freshDb();
		db.close();
		openGovernorDb();
		const d = new Database(DB);
		const uv = (
			d.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		expect(uv).toBeGreaterThanOrEqual(17);
		for (const [tbl, cols] of Object.entries(GOV_TABLES)) {
			const have = (
				d.query(`PRAGMA table_info(${tbl})`).all() as { name: string }[]
			).map((c) => c.name);
			expect(have).toEqual(cols);
		}
		for (const tbl of [...IDENTITY_MOVED, "users", "ceilings"]) {
			const n = (
				d
					.query(
						`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${tbl}'`,
					)
					.get() as { n: number }
			).n;
			expect(n).toBe(0);
		}
		const idb = new Database(IDB);
		for (const [tbl, cols] of Object.entries(IDB_TABLES)) {
			const have = (
				idb.query(`PRAGMA table_info(${tbl})`).all() as { name: string }[]
			).map((c) => c.name);
			expect(have).toEqual(cols);
		}
		d.close();
		idb.close();
	});

	test("deltas triggers cover every table: 10 × 3 = 30 (the identity set left the loop at v17), bus tables still untracked", () => {
		const d = new Database(DB);
		const n = (
			d
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_%'",
				)
				.get() as { n: number }
		).n;
		expect(n).toBe(30);
		const bus = d
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_events_%'",
			)
			.all();
		expect(bus).toEqual([]);
		d.close();
	});

	test("second open is idempotent: version and trigger count unchanged", () => {
		openGovernorDb(); // reopen — must not duplicate anything
		const d = new Database(DB);
		const uv = (
			d.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		const n = (
			d
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'deltas_%'",
				)
				.get() as { n: number }
		).n;
		expect(uv).toBeGreaterThanOrEqual(17);
		expect(n).toBe(30);
		const legacy = d
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_legacy_%'",
			)
			.all();
		expect(legacy).toEqual([]);
		d.close();
	});

	test("api_keys integrity: hash required, key_id PK, jti unique, no raw-key column — on identity.db", () => {
		const idb = new Database(IDB);
		// key_hash NOT NULL — a key without a hash is unauthenticatable
		expect(() =>
			idb
				.query("INSERT INTO api_keys (key_id, created_at) VALUES ('bad', 1)")
				.run(),
		).toThrow();
		// key_id is the PK
		idb
			.query(
				"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('dup', 'h', 1)",
			)
			.run();
		expect(() =>
			idb
				.query(
					"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('dup', 'h2', 1)",
				)
				.run(),
		).toThrow();
		// jti carries a UNIQUE index — the denylist check is one indexed lookup
		idb
			.query(
				"INSERT INTO api_keys (key_id, key_hash, jti, created_at) VALUES ('j1', 'h1', 'jti-x', 1)",
			)
			.run();
		expect(() =>
			idb
				.query(
					"INSERT INTO api_keys (key_id, key_hash, jti, created_at) VALUES ('j2', 'h2', 'jti-x', 1)",
				)
				.run(),
		).toThrow();
		// the column set is exactly the designed one — nothing that could hold
		// a raw secret
		const cols = (
			idb.query("PRAGMA table_info(api_keys)").all() as { name: string }[]
		).map((c) => c.name);
		idb.close();
		expect(cols).toEqual(NEW_TABLES.api_keys);
	});
});

test.describe("deltas coverage — the audit win is the existing loop", () => {
	test("identity plane is deltas-silent: rows land in identity.db, the governor log never sees them", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const idb = new Database(IDB);
		idb
			.query(
				"INSERT INTO api_keys (key_id, key_hash, jti, name, actor, token_type, created_at) VALUES ('k-acc', 'sha256:aa', 'jti-acc', 'owner', 'klh', 'access', ?)",
			)
			.run(Date.now());
		const tbls = (
			db2.query("SELECT DISTINCT tbl FROM deltas").all() as { tbl: string }[]
		).map((r) => r.tbl);
		expect(
			tbls.some((t) => (IDENTITY_MOVED as readonly string[]).includes(t)),
		).toBe(false);
		const got = idb
			.query("SELECT actor, expires_at FROM api_keys WHERE key_id = 'k-acc'")
			.get() as { actor: string; expires_at: number | null };
		expect(got.actor).toBe("klh");
		expect(got.expires_at).toBeNull(); // forever
		idb.close();
		db2.close();
	});

	test("route_audit: decision INSERT + outcome UPDATE by rid = two delta rows", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const now = Date.now();
		db2
			.query(
				"INSERT INTO route_audit (rid, ts, actor, dialect, hint, candidates, resolved_target, decision, latency_class) VALUES ('rid-1', ?, 'demo:alice', 'anthropic', 'prefer local reasoning', 'flash,local-reasoning', 'local:box:8903/reasoning', 'policy', 'fast')",
			)
			.run(now);
		// outcome write (W136 §6 two-write pattern): UPDATE in place by rid
		db2
			.query(
				"UPDATE route_audit SET decision = 'fallback', error_code = 'upstream_5xx' WHERE rid = 'rid-1'",
			)
			.run();
		const rows = db2
			.query(
				"SELECT op, pk, before, after FROM deltas WHERE tbl = 'route_audit' ORDER BY seq",
			)
			.all() as {
			op: string;
			pk: string;
			before: string | null;
			after: string | null;
		}[];
		expect(rows.map((r) => r.op)).toEqual(["insert", "update"]);
		expect(rows.map((r) => r.pk)).toEqual(["rid-1", "rid-1"]);
		expect(JSON.parse(rows[0].after ?? "{}").decision).toBe("policy");
		expect(JSON.parse(rows[0].after ?? "{}").error_code).toBeNull();
		const upd = rows[1];
		expect(JSON.parse(upd.before ?? "{}").decision).toBe("policy");
		expect(JSON.parse(upd.after ?? "{}").decision).toBe("fallback");
		expect(JSON.parse(upd.after ?? "{}").error_code).toBe("upstream_5xx");
		db2.close();
	});

	test("aid_events: event rows land with pk = id, full images", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const now = Date.now();
		db2
			.query(
				"INSERT INTO aid_events (ts, sid, work_item, aid, packet_id, tokens_injected, est_tok_saved) VALUES (?, 'w137-aids', 'W137', 'preseed', '9f3a21', 612, NULL)",
			)
			.run(now);
		// W156: auth_events ride identity.db — the identity plane keeps no
		// deltas log; its writes never image into the governor trail
		const ev = db2.query("SELECT id FROM aid_events").get() as { id: number };
		const rows = db2
			.query(
				"SELECT tbl, op, pk, before, after FROM deltas WHERE tbl = 'aid_events' ORDER BY seq",
			)
			.all() as {
			tbl: string;
			op: string;
			pk: string;
			before: string | null;
			after: string | null;
		}[];
		expect(rows.map((r) => [r.tbl, r.op])).toEqual([["aid_events", "insert"]]);
		expect(rows[0].pk).toBe(String(ev.id));
		expect(rows[0].before).toBeNull();
		const afterEv = JSON.parse(rows[0].after ?? "{}");
		expect(afterEv.est_tok_saved).toBeNull();
		expect(afterEv.tokens_injected).toBe(612);
		db2.close();
	});

	test("teams ride identity.db with the W210 ceilings (no deltas story post-split)", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const idb = new Database(IDB);
		idb
			.query(
				"INSERT INTO teams (team_id, name, department, created_at, rpm_ceiling, tpm_ceiling, tok_ceiling) VALUES ('platform', 'Platform', 'Infrastructure', 1, 60, 100000, 5000000)",
			)
			.run();
		// the deltas loop never sees identity rows (v17 moved the set)
		const n = db2
			.query("SELECT COUNT(*) AS n FROM deltas" + " WHERE tbl = 'teams'")
			.get() as { n: number };
		expect(n.n).toBe(0);
		const got = idb
			.query("SELECT * FROM teams WHERE team_id = 'platform'")
			.get() as { rpm_ceiling: number | null };
		expect(got).toMatchObject({
			rpm_ceiling: 60,
			tpm_ceiling: 100000,
			tok_ceiling: 5000000,
		});
		idb.close();
		db2.close();
	});

	test("v13 heal feeds the v17 split: pre-v13 teams heals, then rides to identity.db whole", () => {
		const db = freshDb();
		// a real pre-split uv-12 DB carries the v8 identity tables (empty);
		// post-split their DDL lives in identity-db.ts — strip its idb. prefix
		for (const [t, stmts] of Object.entries(IDENTITY_DDL))
			if (t !== "teams")
				for (const s of stmts) db.exec(s.replaceAll("idb.", ""));
		// pre-v13 fixture: teams without ceilings + empty deltas
		db.exec(
			"CREATE TABLE teams (team_id TEXT PRIMARY KEY, name TEXT, " +
				"department TEXT, created_at INTEGER NOT NULL)",
		);
		db.exec(
			"CREATE TABLE deltas (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts " +
				"INTEGER NOT NULL, tbl TEXT NOT NULL, op TEXT NOT NULL, pk TEXT " +
				"NOT NULL, before TEXT, after TEXT)",
		);
		db.exec("INSERT INTO teams VALUES ('platform', 'Platform', 'Infra', 7)");
		db.run("PRAGMA user_version = 12");
		db.close();
		openGovernorDb();
		// main.teams dropped by the split; healed shape rides identity.db
		const d = new Database(DB);
		const gone = (
			d
				.query(
					"SELECT COUNT(*) AS n FROM sqlite_master" +
						" WHERE type = 'table' AND name = 'teams'",
				)
				.get() as { n: number }
		).n;
		expect(gone).toBe(0);
		d.close();
		const idb = new Database(IDB);
		const cols = (
			idb.query("PRAGMA table_info(teams)").all() as { name: string }[]
		).map((c) => c.name);
		expect(cols).toEqual(NEW_TABLES.teams);
		const row = idb
			.query("SELECT * FROM teams WHERE team_id = 'platform'")
			.get() as { rpm_ceiling: number | null };
		expect(row).toEqual({
			team_id: "platform",
			name: "Platform",
			department: "Infra",
			created_at: 7,
			rpm_ceiling: null,
			tpm_ceiling: null,
			tok_ceiling: null,
		});
		idb.close();
	});
});

test.describe("aid_rollup — W137 §6 SQL runs verbatim with UPSERT-ADD", () => {
	test("the doc's CREATE TABLE IF NOT EXISTS is a no-op against the v8 table", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		expect(() => db2.run(DOC_AID_ROLLUP_SQL)).not.toThrow();
		// shape unchanged by the verbatim run
		const d = new Database(DB);
		const cols = (
			d.query("PRAGMA table_info(aid_rollup)").all() as { name: string }[]
		).map((c) => c.name);
		d.close();
		expect(cols).toEqual(NEW_TABLES.aid_rollup);
		db2.close();
	});

	test("UPSERT-ADD accumulates; deltas shows insert then update with the composite pk", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const add = db2.query(DML.rollupAdd);
		add.run(1790849100, "preseed", "gaps", "flash", 1, 0, 612, 0, 1);
		add.run(1790849100, "preseed", "gaps", "flash", 2, 1, 388, 0, 1);
		add.run(1790849100, "preseed", "gaps", "luna", 1, 0, 100, 0, 1);
		const row = db2
			.query(
				"SELECT injected, skipped, tok_injected, requests FROM aid_rollup WHERE hour_bucket = 1790849100 AND aid = 'preseed' AND domain = 'gaps' AND model_group = 'flash'",
			)
			.get() as {
			injected: number;
			skipped: number;
			tok_injected: number;
			requests: number;
		};
		expect(row).toEqual({
			injected: 3,
			skipped: 1,
			tok_injected: 1000,
			requests: 2,
		});
		const rows = db2
			.query("SELECT op, pk FROM deltas WHERE tbl = 'aid_rollup' ORDER BY seq")
			.all() as { op: string; pk: string }[];
		expect(rows.map((r) => r.op)).toEqual(["insert", "update", "insert"]);
		expect(rows[0].pk).toBe("1790849100/preseed/gaps/flash");
		expect(rows[1].pk).toBe("1790849100/preseed/gaps/flash");
		db2.close();
	});
});

test.describe("budget_state — W135 async flush upsert semantics", () => {
	test("upsert-ADD accumulates counters and advances window_start on the flusher's word", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const flush = db2.query(DML.budgetFlush);
		flush.run("k-acc", "minute", 5, 1200, 1000);
		flush.run("k-acc", "minute", 3, 800, 1000);
		flush.run("k-acc", "minute", 2, 0, 1060); // window rolled: start advances
		const row = db2
			.query(
				"SELECT used_rpm, used_tpm, window_start FROM budget_state WHERE key_id = 'k-acc' AND window = 'minute'",
			)
			.get() as {
			used_rpm: number;
			used_tpm: number;
			window_start: number;
		};
		expect(row).toEqual({ used_rpm: 10, used_tpm: 2000, window_start: 1060 });
		db2.close();
	});

	test("separate windows stay independent; every flush leaves exactly one delta with pk = key/window", () => {
		const db = freshDb();
		db.close();
		const db2 = openGovernorDb();
		const flush = db2.query(DML.budgetFlush);
		flush.run("k-acc", "minute", 5, 1200, 1000);
		flush.run("k-acc", "day", 1, 5000, 86400);
		const rows = db2
			.query(
				"SELECT op, pk, before, after FROM deltas WHERE tbl = 'budget_state' ORDER BY seq",
			)
			.all() as {
			op: string;
			pk: string;
			before: string | null;
			after: string | null;
		}[];
		expect(rows.map((r) => r.pk)).toEqual(["k-acc/minute", "k-acc/day"]);
		expect(rows.every((r) => r.op === "insert")).toBe(true);
		// a conflict-path flush is an UPDATE in deltas — before/after images
		flush.run("k-acc", "minute", 3, 800, 1000);
		const upd = db2
			.query(
				"SELECT op, before, after FROM deltas WHERE tbl = 'budget_state' AND pk = 'k-acc/minute' ORDER BY seq",
			)
			.all() as { op: string; before: string | null; after: string }[];
		expect(upd.length).toBe(2);
		expect(upd[1].op).toBe("update");
		expect(JSON.parse(upd[1].before).used_rpm).toBe(5);
		expect(JSON.parse(upd[1].after).used_rpm).toBe(8);
		db2.close();
	});
});

