// test/govdb-sid-resolve@unit.e2e.ts — W3021: resolveSidOf canonicalizes a
// raw pi session id onto the receiver's pi-<raw> plane row when that row
// exists (fleet-receiver registers pi-<raw> and writes the canonical sid
// file, W2875). Before this, an unknown raw id passed through untouched and
// the downstream mint (coord bootstrap / work take --as) created a bare twin
// row beside the prefixed canonical row — the C502 split-brain. Exact rows
// keep winning first (W846); unknown ids still pass through; ambiguous
// prefixes still die.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-sid-resolve-"));
// restore before test.afterAll cleanup: the rest of the suite shares this process —
// a leaked fixture HOME rides later spawns' {...process.env} spreads (W1124.11)
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME; // govdb computes REG from HOME at module load — set before the dynamic import
// ?query busts bun's module cache (shared registry across test files) so this
// file's instance binds to the temp HOME, never the production DB.
const govdb = await import(
	`../hooks/lib/govdb/govdb.ts?home=${encodeURIComponent(HOME)}`
);
// file-scope env restore — the rest of the suite shares this process (W1124.11)
test.afterAll(() => {
	process.env.HOME = REAL_HOME;
});

// the receiver's registration shape (hooks/coord/bus.ts bootstrap INSERT):
// minimal NOT NULL columns per govdb-open.ts DDL. OR REPLACE: tests sharing
// a worker process share the fixture db — seeding is idempotent per sid.
function seedSession(db: ReturnType<typeof govdb.openGovernorDb>, sid: string) {
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, 'sid-resolve-fixture', 'worker', 0, 0, 'RUNNING')",
	).run(sid);
}

const RAW = "01a1ca6f-8542-712b-90c3-c3b835bcf5c0";
const OTHER = "7f3b2a10-5c4d-4e8f-9a1b-2d3e4f5a6b7c";

test.describe("@unit W3021 resolveSidOf raw→prefixed pi canonicalization", () => {
	test("raw pi id with an existing pi-<raw> row resolves to the prefixed row", () => {
		const db = govdb.openGovernorDb();
		seedSession(db, `pi-${RAW}`);
		expect(govdb.resolveSidOf(db, RAW)).toBe(`pi-${RAW}`);
		db.close();
	});

	test("prefixed pi-<raw> resolves exact — canonicalization never re-wraps", () => {
		const db = govdb.openGovernorDb();
		seedSession(db, `pi-${RAW}`);
		expect(govdb.resolveSidOf(db, `pi-${RAW}`)).toBe(`pi-${RAW}`);
		db.close();
	});

	test("raw id with no pi- row passes through untouched (W846 unchanged)", () => {
		const db = govdb.openGovernorDb();
		expect(govdb.resolveSidOf(db, OTHER)).toBe(OTHER);
		db.close();
	});

	test("existing bare row wins over pi- canonicalization (exact-first, W846)", () => {
		const db = govdb.openGovernorDb();
		seedSession(db, OTHER);
		seedSession(db, `pi-${OTHER}`);
		expect(govdb.resolveSidOf(db, OTHER)).toBe(OTHER);
		db.close();
	});

	test("truncated raw id does NOT canonicalize — never fabricates the full prefixed id", () => {
		const db = govdb.openGovernorDb();
		seedSession(db, `pi-${RAW}`);
		expect(govdb.resolveSidOf(db, RAW.slice(0, 8))).toBe(RAW.slice(0, 8));
		db.close();
	});

	test("unique bare prefix still expands (W846 expansion intact)", () => {
		const db = govdb.openGovernorDb();
		seedSession(db, OTHER);
		expect(govdb.resolveSidOf(db, OTHER.slice(0, 8))).toBe(OTHER);
		db.close();
	});

	test.afterAll(() => {
		rmSync(HOME, { recursive: true, force: true });
	});
});
