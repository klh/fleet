// coord-poll-paging.test.ts — W644: keyset-paged bus scans. `coord poll` and
// `coord wait` ride `WHERE id > ? … LIMIT ?` pages and the cursor advances to
// the last row EXAMINED, so a dormant lane pays one page per poll instead of
// re-scanning the whole bus tail. Temp HOME under tmpdir; every DB open and
// CLI run happens in a bun subprocess so the parent test process never opens
// the real governor.db (coord-events.test.ts recipe).
import { describe, expect, test, setDefaultTimeout, afterAll } from "bun:test";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const fx = cliFixture("w644-poll-paging");
setDefaultTimeout(300_000);

afterAll(() => fx.cleanup());

const runIn = (code: string): string => fx.seed(code);

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

// read rows via a subprocess import — never open the real governor.db here
const sql = <T>(statement: string): T[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all()));
`),
	);

const idsIn = (out: string): number[] =>
	[...out.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

// one seed: 1200 broadcast odd/even rows, scoped rows interleaved, then
// directed rows for two lanes — ids are deterministic for the assertions
runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const ins = db.query(
	"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'w644-test', ?, ?, ?, ?)",
);
const now = Date.now();
for (let i = 1; i <= 1200; i++) {
	ins.run(now, i % 2 ? "w644.odd" : "w644.even", null, JSON.stringify({ note: \`e\${i}\` }), null);
	if (i % 200 === 0)
		ins.run(now, "w644.scoped", "w644/**", JSON.stringify({ note: \`s\${i}\` }), null);
	if (i % 250 === 0)
		ins.run(now, "w644.other", "other/**", JSON.stringify({ note: \`o\${i}\` }), null);
}
for (let d = 0; d < 3; d++)
	ins.run(now, "w644.direct", null, JSON.stringify({ note: \`direct\${d}\` }), "inboxer");
for (const s of ["x", "y"])
	ins.run(now, "w644.secret", null, JSON.stringify({ note: s }), "other-lane");
db.close();
`);

describe("coord poll/wait — keyset paging (W644)", () => {
	test("poll slices by --limit and replay continues without gaps or overlaps", () => {
		const w1 = runCli([
			"poll",
			"--as",
			"slicer",
			"--kinds",
			"w644.even",
			"--limit",
			"7",
		]);
		expect(w1.code).toBe(0);
		expect(idsIn(w1.out)).toEqual([2, 4, 6, 8, 10, 12, 14]);
		// limit hit: the cursor stops exactly at the last SHOWN row
		expect(
			(
				sql<{ event_id: number }[]>(
					"SELECT event_id FROM cursors WHERE sid = 'slicer'",
				) as { event_id: number }[]
			)[0]?.event_id,
		).toBe(14);
		const w2 = runCli([
			"poll",
			"--as",
			"slicer",
			"--kinds",
			"w644.even",
			"--limit",
			"7",
		]);
		expect(idsIn(w2.out)).toEqual([16, 18, 20, 22, 24, 26, 28]);
		const w3 = runCli([
			"poll",
			"--as",
			"slicer",
			"--kinds",
			"w644.even",
			"--limit",
			"1200",
		]);
		const evens = [
			...new Set([...idsIn(w1.out), ...idsIn(w2.out), ...idsIn(w3.out)]),
		].sort((a, b) => a - b);
		// every w644.even row exactly once — the interleaved scoped inserts
		// shift ids past 200, so derive the expected set from the DB
		const expected = (
			sql<{ id: number }[]>(
				"SELECT id FROM events WHERE kind = 'w644.even' ORDER BY id",
			) as { id: number }[]
		).map((r) => r.id);
		expect(evens).toEqual(expected);
	});

	test("dormant consumer: a zero-match poll still advances the cursor across examined rows", () => {
		// a plain consumer never sees other lanes' targeted rows, so its
		// examined head is the last broadcast row, not MAX(id) overall
		const head =
			(
				sql<{ m: number }[]>(
					"SELECT MAX(id) AS m FROM events WHERE target IS NULL",
				) as { m: number }[]
			)[0]?.m ?? 0;
		const p = runCli(["poll", "--as", "dormant", "--kinds", "w644.nope"]);
		expect(p.out).toContain("(no new events)");
		expect(
			(
				sql<{ event_id: number }[]>(
					"SELECT event_id FROM cursors WHERE sid = 'dormant'",
				) as { event_id: number }[]
			)[0]?.event_id,
		).toBe(head);
		// an event seeded after the dormant poll is delivered, not swallowed
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w644-test', 'w644.nope', ?)")
	.run(Date.now(), JSON.stringify({ note: "late" }));
db.close();
`);
		const p2 = runCli(["poll", "--as", "dormant", "--kinds", "w644.nope"]);
		const nope = (
			sql<{ id: number }[]>(
				"SELECT id FROM events WHERE kind = 'w644.nope' ORDER BY id",
			) as { id: number }[]
		).map((r) => r.id);
		expect(idsIn(p2.out)).toEqual(nope);
	});

	test("target filtering preserved: --as sees broadcasts + own directed rows, never other lanes'", () => {
		const p = runCli(["poll", "--as", "inboxer", "--limit", "2000"]);
		expect(p.code).toBe(0);
		const seen = idsIn(p.out);
		// broadcasts 1..1210 (contiguous) + 3 directed-to-inboxer rows; the two
		// other-lane rows (1214, 1215) excluded. The dormant test's late
		// w644.nope broadcast (id > 1215) is a legitimate inboxer row too.
		const nope = (
			sql<{ id: number }[]>(
				"SELECT id FROM events WHERE kind = 'w644.nope' ORDER BY id",
			) as { id: number }[]
		).map((r) => r.id);
		expect(seen).toEqual(
			[...Array.from({ length: 1213 }, (_, i) => i + 1), ...nope].sort(
				(a, b) => a - b,
			),
		);
	});

	test("scope filtering preserved (scopeCovers both directions), cursor rides examined rows", () => {
		const p = runCli([
			"poll",
			"--as",
			"scopey",
			"--scope",
			"w644/**",
			"--limit",
			"100",
		]);
		// 6 w644.scoped rows seeded; every other row examined-and-skipped
		expect((p.out.match(/w644\.scoped/g) ?? []).length).toBe(6);
		expect(p.out).not.toContain("other/**");
		const head =
			(
				sql<{ m: number }[]>(
					"SELECT MAX(id) AS m FROM events WHERE target IS NULL",
				) as { m: number }[]
			)[0]?.m ?? 0;
		expect(
			(
				sql<{ event_id: number }[]>(
					"SELECT event_id FROM cursors WHERE sid = 'scopey'",
				) as { event_id: number }[]
			)[0]?.event_id,
		).toBe(head);
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
db.query("INSERT INTO events (ts, source, kind, scope, payload) VALUES (?, 'w644-test', 'w644.scoped', 'w644/**', ?)")
	.run(Date.now(), JSON.stringify({ note: "late-scope" }));
db.close();
`);
		const p2 = runCli([
			"poll",
			"--as",
			"scopey",
			"--scope",
			"w644/**",
			"--limit",
			"100",
		]);
		expect((p2.out.match(/w644\.scoped/g) ?? []).length).toBe(1);
	});

	test("wait replays through the same pages, then idles bounded at the head", () => {
		const w1 = runCli([
			"wait",
			"--as",
			"waiter",
			"--kinds",
			"w644.even",
			"--max-seconds",
			"5",
		]);
		expect(w1.code).toBe(0);
		// no --limit in wait: every matching row in the tail prints once
		expect((w1.out.match(/w644\.even/g) ?? []).length).toBe(600);
		const t0 = Date.now();
		const w2 = runCli(["wait", "--as", "waiter", "--max-seconds", "2"]);
		expect(w2.out).toContain("(timeout, no events)");
		// cursor already at the head → the idle scan is one empty page, fast
		expect(Date.now() - t0).toBeLessThan(15_000);
	});

	test("anonymous poll keeps its replay window and writes no cursor", () => {
		const before =
			(
				sql<{ n: number }[]>("SELECT COUNT(*) AS n FROM cursors") as {
					n: number;
				}[]
			)[0]?.n ?? 0;
		const p = runCli(["poll"]);
		expect(p.code).toBe(0);
		expect(idsIn(p.out)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
		expect(
			(
				sql<{ n: number }[]>("SELECT COUNT(*) AS n FROM cursors") as {
					n: number;
				}[]
			)[0]?.n ?? 0,
		).toBe(before);
	});
});
