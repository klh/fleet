// test/release-manifest.test.ts — W698: release manifest + SBOM + the schema
// upgrade / migration-failure / rollback-compat contract.
import { expect, test } from "./pw";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRelease,
	checkoutSha,
	MANIFEST_SCHEMA,
	schemaVersions,
} from "../deploy/release-manifest.ts";
import { parseBunLock, parseImagePins } from "../deploy/sbom.ts";

const HOME = mkdtempSync(join(tmpdir(), "fleet-w698-"));
// restore before test.afterAll cleanup: the rest of the suite shares this process —
// a leaked fixture HOME rides later spawns' {...process.env} spreads (W1124.11)
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME; // govdb pins REG from HOME at module load
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const REGDIR = join(HOME, ".cache/claude-governor");
test.afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});
test.beforeEach(() => {
	for (const f of ["governor.db", "governor.db-wal", "governor.db-shm"])
		rmSync(join(REGDIR, f), { force: true });
});

const ROOT = join(import.meta.dir, "../../..");
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

// a from-scratch ladder build: test.beforeEach wipes the DB files, so the first
// open in any test migrates an empty file to the current tip
const freshTip = (): number => {
	const db: Db = govdb.openGovernorDb();
	const v = uv(db);
	db.close();
	return v;
};

// arbitrary passthrough input for the pure manifest tests (buildRelease
// echoes whatever versions it is handed) — the real ladder-tip contract is
// asserted below against freshTip(), never a copied pin
const SCHEMA_IN = { governor: 15, knowledge: 0 };

type Comp = {
	type: string;
	name: string;
	purl?: string;
	hashes?: { alg: string }[];
};
type Intent = { intent: string };
type Manifest = {
	schema: string;
	fleet: { sha: string; pinned?: string; pinnedMatchesSha?: boolean };
	lock: { sha256: string };
	runtime: { images: { digest: string }[]; unpinnedImages: string[] };
	schemaVersions: { governor: number };
	checksums: Record<string, string>;
};
type Db = ReturnType<typeof govdb.openGovernorDb>;
const uv = (db: Db): number =>
	(db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
const snapshot = (db: Db): Record<string, string[]> => {
	const out: Record<string, string[]> = {};
	const tables = db
		.query("SELECT name FROM sqlite_master WHERE type='table'")
		.all() as { name: string }[];
	for (const { name } of tables)
		out[name] = (
			db.query(`PRAGMA table_info(${name})`).all() as { name: string }[]
		).map((c) => c.name);
	return out;
};

// ─── manifest ────────────────────────────────────────────────────────────────

test("manifest pins sha, lock digest, image digests, schema versions", () => {
	const r = buildRelease({
		sha: "a".repeat(40),
		pinned: "a".repeat(40),
		schema: SCHEMA_IN,
	});
	const m = r.manifest as Manifest;
	expect(m.schema).toBe(MANIFEST_SCHEMA);
	expect(m.fleet).toEqual({
		sha: "a".repeat(40),
		pinned: "a".repeat(40),
		pinnedMatchesSha: true,
	});
	expect(m.lock.sha256).toBe(sha(readFileSync(join(ROOT, "bun.lock"), "utf8")));
	expect(m.runtime.images.length).toBeGreaterThan(0);
	for (const i of m.runtime.images)
		expect(i.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(m.runtime.unpinnedImages).toEqual([]);
	expect(m.schemaVersions.governor).toBe(15);
	// checksums cover the SBOM + notice the same run emitted
	expect(m.checksums["sbom.cdx.json"]).toBe(sha(r.sbom));
	expect(m.checksums["THIRD-PARTY-NOTICES.txt"]).toBe(sha(r.notices));
});

test("a pin that differs from the checkout sha is flagged", () => {
	const r = buildRelease({
		sha: "a".repeat(40),
		pinned: "b".repeat(40),
		schema: SCHEMA_IN,
	});
	expect((r.manifest as Manifest).fleet.pinnedMatchesSha).toBe(false);
});

test("hubctl manifest <hub> emits the manifest with the stack pin", async () => {
	const stack = join(HOME, "stack.json");
	const pin = "0123456789abcdef0123456789abcdef01234567";
	await Bun.write(stack, JSON.stringify({ version: pin, hubs: { t: {} } }));
	const hubctl = join(import.meta.dir, "../deploy/hubctl.ts");
	const r = Bun.spawnSync([process.execPath, hubctl, "manifest", "t"], {
		stdout: "pipe",
		env: { ...process.env, KLH_STACK: stack },
	});
	expect(r.exitCode).toBe(0);
	const m = JSON.parse(r.stdout.toString()) as Manifest;
	expect(m.fleet.pinned).toBe(pin);
	expect(m.fleet.pinnedMatchesSha).toBe(false);
	// the manifest reports the REAL ladder tip (fresh-DB probe), not a pin
	expect(m.schemaVersions.governor).toBe(freshTip());
});

test("deterministic: same inputs → byte-identical manifest, SBOM, notice", () => {
	const input = { sha: "c".repeat(40), schema: SCHEMA_IN };
	const a = buildRelease(input);
	const b = buildRelease(input);
	expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
	expect(a.sbom).toBe(b.sbom);
	expect(a.notices).toBe(b.notices);
});

test("schemaVersions probe reports the real ladder tip", () => {
	expect(schemaVersions().governor).toBe(freshTip());
	expect(checkoutSha()).toMatch(/^[0-9a-f]{40}$/);
});

// ─── SBOM ────────────────────────────────────────────────────────────────────

test("SBOM is CycloneDX 1.5 with lock hashes and image digests", () => {
	const r = buildRelease({
		sha: "d".repeat(40),
		schema: SCHEMA_IN,
	});
	const bom = JSON.parse(r.sbom);
	expect(bom.bomFormat).toBe("CycloneDX");
	expect(bom.specVersion).toBe("1.5");
	const libs = bom.components.filter((c: Comp) => c.type === "library");
	expect(libs.length).toBeGreaterThan(10);
	expect(libs.every((c: Comp) => c.purl?.startsWith("pkg:npm/"))).toBe(true);
	expect(libs.some((c: Comp) => c.hashes?.[0]?.alg === "SHA-512")).toBe(true);
	const images = bom.components.filter((c: Comp) => c.type === "container");
	expect(images.some((c: Comp) => c.name === "oven/bun:1")).toBe(true);
	expect(r.notices).toContain("THIRD-PARTY NOTICES");
});

test("parsers: JSONC lock rows + digest-pinned vs floating images", () => {
	const lock = `{"packages": {"@a/b": ["@a/b@1.2.3", "", {"dependencies": {"c": "^1"},}, "sha512-AAEC"],\n"c": ["c@2.0.0", "", {}, "sha512-AAEC"],\n"@klh/x": ["@klh/x@workspace:packages/x"],}}`;
	const rows = parseBunLock(lock);
	expect(rows.map((r) => r.name)).toEqual(["@a/b", "@klh/x", "c"]);
	expect(rows[0].sha512).toBe("000102");
	expect(rows[1].source).toBe("workspace");
	expect(rows[0].deps).toEqual(["c"]);
	const pins = parseImagePins(
		"  image: oven/bun:1@sha256:abc\n  image: alpine:3.20\n  image: *anchor\n",
	);
	expect(pins).toEqual([
		{ ref: "alpine:3.20", digest: null },
		{ ref: "oven/bun:1", digest: "sha256:abc" },
	]);
});

// ─── schema upgrade / migration failure / rollback compat ───────────────────

/** Build a v12-shaped DB the way the current ladder heals it: a fresh open
 *  (tip shape), a claims row, then recreate the governor-side pre-split
 *  identity tables the v8 ladder used to own — teams in its W141 form (no
 *  entitlement ceilings), stamp v12. This is the DB a hub still on the
 *  pre-W210 release holds. */
function makeV12(): Record<string, string[]> {
	const db: Db = govdb.openGovernorDb();
	db.run(
		"INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('s1','scope','keep-me',0,1)",
	);
	db.run(
		"CREATE TABLE teams (team_id TEXT PRIMARY KEY, name TEXT, department TEXT, created_at INTEGER NOT NULL)",
	);
	db.run("INSERT INTO teams (team_id, name, created_at) VALUES ('t1','P',1)");
	// the rest of the v8 identity plane the v17 copy path selects from
	db.run(
		"CREATE TABLE api_keys (key_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, jti TEXT, name TEXT, team TEXT, actor TEXT, token_type TEXT NOT NULL DEFAULT 'access', parent_key_id TEXT, scopes TEXT, rpm_limit INTEGER, tpm_limit INTEGER, expires_at INTEGER, rotated_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL)",
	);
	db.run(
		"CREATE TABLE auth_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, event TEXT NOT NULL, jti TEXT, via TEXT)",
	);
	db.run(
		"INSERT INTO api_keys (key_id, key_hash, created_at) VALUES ('k1','sha256:x',1)",
	);
	db.run(
		"INSERT INTO auth_events (ts, actor, event) VALUES (1,'lane','issued')",
	);
	db.run("PRAGMA user_version = 12");
	const shape = snapshot(db);
	db.close();
	return shape;
}

test("upgrade: v12 DB migrates to the tip, keeps rows, drops nothing", () => {
	const tip = freshTip(); // from-scratch build, captured before the fixture
	const before = makeV12();
	expect(before.teams).not.toContain("rpm_ceiling");
	const db: Db = govdb.openGovernorDb();
	expect(uv(db)).toBe(tip); // the whole ladder, v12 → current
	const after = snapshot(db);
	// the v17 split removed the identity tables from governor.db — teams
	// (healed with the W210 ceilings at v13) now lives in identity.db
	expect(after.teams).toBeUndefined();
	const moved = new Set(["teams", "api_keys", "auth_events"]);
	for (const [table, cols] of Object.entries(before)) {
		if (moved.has(table)) continue; // asserted on the identity side below
		for (const c of cols) expect(after[table] ?? []).toContain(c); // additive-only
	}
	// every identity row rode the v17 split into identity.db, teams healed
	// with the W210 ceiling columns on the way through
	const idb = new (require("bun:sqlite").Database)(join(REGDIR, "identity.db"));
	const idbTeams = (
		idb.query("PRAGMA table_info(teams)").all() as { name: string }[]
	).map((c) => c.name);
	for (const c of before.teams) expect(idbTeams).toContain(c);
	for (const c of ["rpm_ceiling", "tpm_ceiling", "tok_ceiling"])
		expect(idbTeams).toContain(c);
	expect(
		(
			idb.query("SELECT name FROM teams WHERE team_id='t1'").get() as {
				name: string;
			}
		).name,
	).toBe("P");
	expect(idb.query("SELECT key_id FROM api_keys").get()).not.toBeNull();
	expect(idb.query("SELECT id FROM auth_events").get()).not.toBeNull();
	idb.close();
	expect(
		(db.query("SELECT intent FROM claims WHERE sid='s1'").get() as Intent)
			.intent,
	).toBe("keep-me");
	db.close();
});

test("migration failure is atomic: rolled back, version held, retry heals", () => {
	const tip = freshTip(); // from-scratch build, captured before the mutation
	const db: Db = govdb.openGovernorDb();
	db.run("PRAGMA user_version = 14");
	for (const t of [
		"id_checkouts",
		"id_repositories",
		"id_projects",
		"id_tenants",
	])
		db.run(`DROP TABLE ${t}`);
	// an incompatible pre-existing id_projects: the v15 index DDL cannot apply
	db.run("CREATE TABLE id_projects (bogus TEXT)");
	db.close();

	expect(() => govdb.openGovernorDb()).toThrow(/identity registry migration/);

	const probe = new (require("bun:sqlite").Database)(
		join(REGDIR, "governor.db"),
	);
	const names = (
		probe
			.query("SELECT name FROM sqlite_master WHERE name LIKE 'id_%'")
			.all() as {
			name: string;
		}[]
	).map((r) => r.name);
	expect(names).toEqual(["id_projects"]); // id_tenants (created first) rolled back
	expect(
		(probe.query("PRAGMA user_version").get() as { user_version: number })
			.user_version,
	).toBe(14); // never stamped past a failed step
	probe.run("DROP TABLE id_projects");
	probe.close();

	const healed: Db = govdb.openGovernorDb(); // operator fixes, retry succeeds
	expect(uv(healed)).toBe(tip);
	healed.close();
});

test("rollback compat: older binary's view survives, re-upgrade is idempotent", () => {
	const tip = freshTip(); // from-scratch build, captured before the fixture
	const db: Db = govdb.openGovernorDb();
	db.run(
		"INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('s2','scope','new-era',0,2)",
	);
	const shape = snapshot(db);
	// the previous release stamps nothing above its own tip and never reads
	// columns it does not know — roll back = a lower stamp over a superset shape
	db.run("PRAGMA user_version = 12");
	db.close();
	const again: Db = govdb.openGovernorDb(); // roll forward again
	expect(uv(again)).toBe(tip);
	expect(snapshot(again)).toEqual(shape); // identical shape, no churn
	expect(
		(again.query("SELECT intent FROM claims WHERE sid='s2'").get() as Intent)
			.intent,
	).toBe("new-era");
	again.close();
});
