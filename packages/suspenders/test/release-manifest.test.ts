// test/release-manifest.test.ts — W698: release manifest + SBOM + the schema
// upgrade / migration-failure / rollback-compat contract.
import { afterAll, beforeEach, expect, test } from "bun:test";
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
// restore before afterAll cleanup: the rest of the suite shares this process —
// a leaked fixture HOME rides later spawns' {...process.env} spreads (W1124.11)
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME; // govdb pins REG from HOME at module load
const govdb = await import(
	`../hooks/lib/govdb.ts?home=${encodeURIComponent(HOME)}`
);
const REGDIR = join(HOME, ".cache/claude-governor");
afterAll(() => {
	process.env.HOME = REAL_HOME;
	rmSync(HOME, { recursive: true, force: true });
});
beforeEach(() => {
	for (const f of ["governor.db", "governor.db-wal", "governor.db-shm"])
		rmSync(join(REGDIR, f), { force: true });
});

const ROOT = join(import.meta.dir, "../../..");
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");

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
		schema: { governor: 15, knowledge: 0 },
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
		schema: { governor: 15, knowledge: 0 },
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
	expect(m.schemaVersions.governor).toBe(15);
});

test("deterministic: same inputs → byte-identical manifest, SBOM, notice", () => {
	const input = { sha: "c".repeat(40), schema: { governor: 15, knowledge: 0 } };
	const a = buildRelease(input);
	const b = buildRelease(input);
	expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
	expect(a.sbom).toBe(b.sbom);
	expect(a.notices).toBe(b.notices);
});

test("schemaVersions probe reports the real ladder tip", () => {
	expect(schemaVersions().governor).toBe(15);
	expect(checkoutSha()).toMatch(/^[0-9a-f]{40}$/);
});

// ─── SBOM ────────────────────────────────────────────────────────────────────

test("SBOM is CycloneDX 1.5 with lock hashes and image digests", () => {
	const r = buildRelease({
		sha: "d".repeat(40),
		schema: { governor: 15, knowledge: 0 },
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

/** Strip a fresh v15 DB back to the v12 shape (pre team-ceiling columns) with
 *  data in it — the DB a hub still on the previous release holds. */
function makeV12(): Record<string, string[]> {
	const db: Db = govdb.openGovernorDb();
	db.run(
		"INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('s1','scope','keep-me',0,1)",
	);
	for (const op of ["insert", "update", "delete"])
		db.run(`DROP TRIGGER IF EXISTS deltas_teams_${op}`);
	for (const col of ["rpm_ceiling", "tpm_ceiling", "tok_ceiling"])
		db.run(`ALTER TABLE teams DROP COLUMN ${col}`);
	db.run("PRAGMA user_version = 12");
	const shape = snapshot(db);
	db.close();
	return shape;
}

test("upgrade: v12 DB migrates to v15, keeps rows, drops nothing", () => {
	const before = makeV12();
	expect(before.teams).not.toContain("rpm_ceiling");
	const db: Db = govdb.openGovernorDb();
	expect(uv(db)).toBe(15);
	const after = snapshot(db);
	expect(after.teams).toContain("rpm_ceiling");
	for (const [table, cols] of Object.entries(before))
		for (const c of cols) expect(after[table]).toContain(c); // additive-only
	expect(
		(db.query("SELECT intent FROM claims WHERE sid='s1'").get() as Intent)
			.intent,
	).toBe("keep-me");
	db.close();
});

test("migration failure is atomic: rolled back, version held, retry heals", () => {
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
	expect(uv(healed)).toBe(15);
	healed.close();
});

test("rollback compat: older binary's view survives, re-upgrade is idempotent", () => {
	const v15: Db = govdb.openGovernorDb();
	v15.run(
		"INSERT INTO claims (sid, scope, intent, hot, ts) VALUES ('s2','scope','new-era',0,2)",
	);
	const shape = snapshot(v15);
	// the previous release stamps nothing above its own tip and never reads
	// columns it does not know — roll back = a lower stamp over a superset shape
	v15.run("PRAGMA user_version = 12");
	v15.close();
	const again: Db = govdb.openGovernorDb(); // roll forward again
	expect(uv(again)).toBe(15);
	expect(snapshot(again)).toEqual(shape); // identical shape, no churn
	expect(
		(again.query("SELECT intent FROM claims WHERE sid='s2'").get() as Intent)
			.intent,
	).toBe("new-era");
	again.close();
});
