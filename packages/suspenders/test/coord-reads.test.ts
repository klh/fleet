// coord-reads.test.ts — W652.2: the event-read consolidation. subscribe is
// THE face (WS push); wait/poll/inbox ride the ONE readEvents core and share
// the cursor contract: advances only past SHOWN. Recipe: coord-events.test.ts
// (temp HOME, every DB open + CLI run in a bun subprocess).
import { describe, expect, test, afterAll } from "bun:test";
import { join } from "node:path";
import { cliFixture } from "./helpers/cli-e2e-harness.ts";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb", "govdb.ts");
const fx = cliFixture("w652-reads");

afterAll(() => fx.cleanup());

const runIn = (code: string): string => fx.seed(code);

const runCli = (args: string[]): { code: number; out: string; err: string } =>
	fx.run("coord.ts", args);

const sql = <T>(statement: string): T[] =>
	JSON.parse(
		runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
console.log(JSON.stringify(openGovernorDb().query(${JSON.stringify(statement)}).all()));
`),
	);

// seed: two bus events + one directed at the test lane
runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const now = Date.now();
db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w652', 'w652.alpha', ?)").run(now, JSON.stringify({ note: "bus one" }));
db.query("INSERT INTO events (ts, source, kind, payload) VALUES (?, 'w652', 'w652.beta', ?)").run(now + 1, JSON.stringify({ note: "bus two", sha: "c0ffee1" }));
db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'w652', 'NEED_DECISION', NULL, ?, 'w652-lane')").run(now + 2, JSON.stringify({ note: "ship or hold?" }));
db.close();
`);

describe("coord event reads — one core (W652.2)", () => {
	test("poll: renders via formatEventLine, cursor advances past SHOWN", () => {
		const p = runCli(["poll", "--as", "w652-lane"]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("#1");
		expect(p.out).toContain("w652.alpha");
		expect(p.out).toContain("w652"); // source glyph (formatEventLine parity)
		expect(p.out).toContain("@c0ffee1"); // sha glyph
		// cursor now sits past ALL shown rows — poll's read is bus + directed
		expect(p.out).toContain("NEED_DECISION"); // directed row renders too
		const cur = sql<{ event_id: number }>(
			"SELECT event_id FROM cursors WHERE sid = 'w652-lane'",
		);
		expect(cur.length).toBe(1);
		expect(cur[0].event_id).toBe(3); // max SHOWN id
	});

	test("poll again: everything shown was consumed", () => {
		const p = runCli(["poll", "--as", "w652-lane"]);
		expect(p.out).toContain("(no new events)");
		const cur = sql<{ event_id: number }>(
			"SELECT event_id FROM cursors WHERE sid = 'w652-lane'",
		);
		expect(cur[0].event_id).toBe(3);
	});

	test("filtered poll advances past examined rows; excluded kinds are intentionally consumed", () => {
		runCli(["emit", "w652.gamma", "--note", "three"]);
		runCli(["emit", "w652.delta", "--note", "four"]);
		const p = runCli(["poll", "--as", "w652-lane", "--kinds", "w652.gamma"]);
		expect(p.out).toContain("w652.gamma");
		expect(p.out).not.toContain("w652.delta");
		const cur = sql<{ event_id: number }>(
			"SELECT event_id FROM cursors WHERE sid = 'w652-lane'",
		);
		expect(cur[0].event_id).toBe(5); // delta was examined and excluded
		const next = runCli(["poll", "--as", "w652-lane"]);
		expect(next.out).not.toContain("w652.delta");
	});

	test("wait prints matching rows and exits (no --forever)", () => {
		runCli(["emit", "w652.eps", "--note", "five"]);
		const p = runCli([
			"wait",
			"--as",
			"w652-lane",
			"--kinds",
			"w652.eps",
			"--max-seconds",
			"5",
		]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("w652.eps");
	});

	test("wait timeout: quiet exit-0 when nothing matches", () => {
		const p = runCli([
			"wait",
			"--as",
			"w652-lane",
			"--kinds",
			"w652.nope",
			"--max-seconds",
			"1",
		]);
		expect(p.code).toBe(0);
		expect(p.out).toContain("(timeout, no events)");
	});

	test("inbox: directed-only render, cursor untouched without --ack", () => {
		runCli(["emit", "w652.msg", "--to", "w652-lane2", "--note", "direct"]);
		const p = runCli(["inbox", "--as", "w652-lane2"]);
		expect(p.out).toContain("w652.msg");
		expect(p.out).toContain("direct");
		expect(p.out).toContain("w652"); // source glyph — formatEventLine parity
		expect(
			sql<{ event_id: number }>(
				"SELECT event_id FROM cursors WHERE sid = 'w652-lane2'",
			).length,
		).toBe(0); // no cursor row minted without --ack
	});

	test("inbox --ack advances to max SHOWN, monotonic", () => {
		const p = runCli(["inbox", "--as", "w652-lane2", "--ack"]);
		expect(p.out).toContain("w652.msg");
		const cur = sql<{ event_id: number }>(
			"SELECT event_id FROM cursors WHERE sid = 'w652-lane2'",
		);
		expect(cur.length).toBe(1);
		expect(cur[0].event_id).toBeGreaterThan(0);
		const again = runCli(["inbox", "--as", "w652-lane2"]);
		expect(again.out).toContain("(inbox empty)");
	});
});
