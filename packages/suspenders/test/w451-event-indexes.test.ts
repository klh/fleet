// w451-event-indexes.test.ts — W451 hub longevity: measured indexes + keyset
// pagination on the event/audit views. BEFORE this change every query below
// was a full table walk — EXPLAIN QUERY PLAN showed `SCAN events` (the bus
// had no index beyond the rowid PK), `SCAN aid_events`, `SCAN auth_events`;
// the board re-ran those scans once per second per open tab. After:
// `SEARCH <table> USING INDEX <idx>`. The EQP shapes are asserted so the
// regression guard outlives the one-time evidence. Temp HOME under the repo
// (never /tmp); every DB open happens in a bun subprocess so the parent test
// process never opens the real governor.db (coord-events.test.ts recipe).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const DATA = join(import.meta.dir, "..", "hooks", "board", "data.ts");
const AUDIT = join(import.meta.dir, "..", "hooks", "lib", "admin-audit.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-w451-indexes-test-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const runIn = (code: string): string => {
	const p = Bun.spawnSync(["bun", "-e", code], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (p.exitCode !== 0)
		throw new Error(`spawn failed: ${new TextDecoder().decode(p.stderr)}`);
	return new TextDecoder().decode(p.stdout);
};

// EXPLAIN QUERY PLAN detail lines for a statement (subprocess — store lib
// only, never raw sqlite3 against the real governor.db)
const eqp = (statement: string): string[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
console.log(JSON.stringify(db.query("EXPLAIN QUERY PLAN " + ${JSON.stringify(statement)}).all().map((r) => r.detail)));
`),
	);

// one subprocess seeds the bus with realistic volume (1200 events across the
// hot kinds + the audit tables); ts spread drives the window queries below
runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = Date.now();
const ev = db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'w451-test', ?, ?, ?, ?)");
for (let i = 0; i < 400; i++)
	ev.run(now - i * 1000, "work.ready", null, JSON.stringify({ project: "/p", note: "n" }), null);
for (let i = 0; i < 400; i++)
	ev.run(now - i * 60_000, "llm.call", null, JSON.stringify({ model: i % 2 ? "m1" : "m2", tokens: i }), null);
for (let i = 0; i < 200; i++)
	ev.run(now - i * 1000, "BROADCAST", null, JSON.stringify({ note: "b" }), null);
for (let i = 0; i < 200; i++)
	ev.run(now - i * 1000, "consult", null, JSON.stringify({ note: "t" }), "w451-inbox");
const aid = db.query("INSERT INTO aid_events (ts, sid, aid, tokens_injected) VALUES (?, 's', 'a', 1)");
for (let i = 0; i < 50; i++) aid.run(now - i * 1000);
const au = db.query("INSERT INTO auth_events (ts, actor, event) VALUES (?, 'k', 'deny')");
for (let i = 0; i < 50; i++) au.run(now - i * 1000);
const ad = db.query("INSERT INTO admin_audit (ts, actor, action, target, detail) VALUES (?, 'k', 'settings.apply', 't', 'd')");
for (let i = 0; i < 30; i++) ad.run(now - i * 1000);
db.close();
`);

describe("W451 event/audit indexes — EXPLAIN QUERY PLAN evidence", () => {
	test("the five W451 indexes exist", () => {
		const names = JSON.parse(
			runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
console.log(JSON.stringify(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%events%' OR name IN ('aid_events_ts','auth_events_ts')").all().map((r) => r.name)));
`),
		) as string[];
		for (const n of [
			"events_kind_id",
			"events_kind_ts",
			"events_target_id",
			"aid_events_ts",
			"auth_events_ts",
		])
			expect(names).toContain(n);
	});

	test("coord events --kinds shape: kind tail rides a kind index, not a scan", () => {
		const [plan] = eqp(
			"SELECT id, ts, source, kind, scope, payload FROM events WHERE kind IN ('work.ready','llm.call') ORDER BY id DESC LIMIT 50",
		);
		// planner picks events_kind_ts here; the sort is a temp b-tree over the
		// bounded matched set (one index row per kind member), not a table walk
		expect(plan).toMatch(/SEARCH.*events_kind_/);
		expect(plan).not.toMatch(/^SCAN events/);
	});

	test("llm recent + daily aggregate ride the kind/ts index, not a scan", () => {
		const since = Date.now() - 3_600_000;
		const [recent] = eqp(
			`SELECT id, ts, source, kind, payload FROM events WHERE kind='llm.call' AND ts >= ${since} ORDER BY id DESC LIMIT 20`,
		);
		const [agg] = eqp(
			`SELECT json_extract(payload, '$.model') AS m, COUNT(*) FROM events WHERE kind='llm.call' AND ts >= ${since} GROUP BY m`,
		);
		expect(recent).toMatch(/SEARCH.*events_kind_/);
		expect(agg).toMatch(/SEARCH.*events_kind_ts/);
		expect(agg).not.toMatch(/^SCAN events/);
	});

	test("inbox/state keyset read rides events_target_id", () => {
		const [plan] = eqp(
			"SELECT id, ts, source, kind, scope, payload FROM events WHERE target = 'w451-inbox' AND id > 5 ORDER BY id",
		);
		expect(plan).toMatch(/SEARCH.*events_target_id/);
	});

	test("aids window scan rides aid_events_ts", () => {
		const [plan] = eqp(
			`SELECT * FROM aid_events WHERE ts > ${Date.now() - 60_000} ORDER BY ts LIMIT 20`,
		);
		expect(plan).toMatch(/SEARCH.*aid_events_ts/);
	});

	test("retention window DELETE rides auth_events_ts", () => {
		const [plan] = eqp(
			`DELETE FROM auth_events WHERE ts < ${Date.now() - 3_600_000}`,
		);
		expect(plan).toMatch(/SEARCH.*auth_events_ts/);
		expect(plan).not.toMatch(/^SCAN auth_events/);
	});
});

describe("W451 keyset pagination — bus feed + admin audit", () => {
	test("/api/activity shape: pages join without gap or overlap, cursor ends", () => {
		// the drain runs inside ONE subprocess (no per-hop spawn)
		const drained = JSON.parse(
			runIn(`
const { activity } = await import(${JSON.stringify(DATA)});
const pages = [];
let cur;
for (;;) {
	const r = activity(null, 7, cur);
	pages.push(...r.events);
	if (r.nextCursor === null) break;
	cur = r.nextCursor;
}
const ids = pages.map((e) => e.id);
const sortedDesc = ids.every((id, i) => i === 0 || id < ids[i - 1]);
console.log(JSON.stringify({ n: ids.length, unique: new Set(ids).size, sortedDesc }));
`),
		) as { n: number; unique: number; sortedDesc: boolean };
		expect(drained.n).toBe(1200); // drained every seeded event
		expect(drained.unique).toBe(1200); // no gap or overlap
		expect(drained.sortedDesc).toBe(true);
	});

	test("first page + cursor semantics", () => {
		const p1 = JSON.parse(
			runIn(`
const { activity } = await import(${JSON.stringify(DATA)});
console.log(JSON.stringify(activity(null, 7)));
`),
		) as { events: { id: number }[]; nextCursor: number | null };
		expect(p1.events).toHaveLength(7);
		expect(p1.nextCursor).toBe(p1.events[6].id);
	});

	test("recentAdminAudit: before= drains pages newest-first without overlap", () => {
		const read = (before?: number): { rows: { id: number }[] } =>
			JSON.parse(
				runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const { recentAdminAudit } = await import(${JSON.stringify(AUDIT)});
const db = openGovernorDb();
console.log(JSON.stringify({ rows: recentAdminAudit(db, 12, ${before === undefined ? "undefined" : String(before)}) }));
`),
			) as { rows: { id: number }[] };
		const p1 = read();
		expect(p1.rows).toHaveLength(12);
		const p2 = read(p1.rows[11].id);
		expect(p2.rows[0].id).toBeLessThan(p1.rows[11].id);
		const p3 = read(p2.rows[11].id);
		expect(p3.rows).toHaveLength(6); // partial page = the end
		const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
		expect(new Set(seen).size).toBe(30);
	});
});
