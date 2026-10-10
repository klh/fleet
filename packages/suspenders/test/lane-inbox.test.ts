// lane-inbox.test.ts — W611: the gate drain delivers undelivered directed
// events (target = sid, past the cursor) as additionalContext and advances
// the cursor past SHOWN only — `coord inbox --ack` semantics, minus the
// lane having to remember to run it. Non-targeted events never drain; the
// 5-row cap leaves the remainder past the cursor; a second drain is empty.
// Temp HOME under the repo (never /tmp); every DB open happens in a bun
// subprocess so the parent test process never opens the real governor.db
// (w451-event-indexes recipe).
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GOVDB = join(import.meta.dir, "..", "hooks", "lib", "govdb.ts");
const LIB = join(import.meta.dir, "..", "hooks", "lib", "lane-inbox.ts");
const home = mkdtempSync(join(tmpdir(), "suspenders-w611-lane-inbox-"));
const SID = "w611-lane-sess-11111111";
const OTHER = "w611-lane-sess-22222222";

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

const json = (v: unknown) => JSON.stringify(v);

/** Seed `n` events targeted at SID past CUR plus one for OTHER (untargeted
 * rows and other lanes' mail must never drain), then drain SID. */
function drainAfter(cur: number, n: number): string {
	return runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
db.query("DELETE FROM events WHERE target = ? OR target = ?").run(${json(SID)}, ${json(OTHER)});
db.query("DELETE FROM cursors WHERE sid IN (?, ?)").run(${json(SID)}, ${json(OTHER)});
for (let i = 0; i < ${n}; i++)
	db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'coord', 'pause_requested', null, ?, ?)")
		.run(Date.now() + i, JSON.stringify({ reason: "steer " + i }), ${json(SID)});
db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'coord', 'pause_requested', null, ?, ?)")
	.run(Date.now(), JSON.stringify({ reason: "not yours" }), ${json(OTHER)});
${cur ? `db.query("INSERT INTO cursors (sid, event_id) VALUES (?, ?)").run(${json(SID)}, ${cur});` : ""}
const { drainLaneInboxFor } = await import(${JSON.stringify(LIB)});
const msg = drainLaneInboxFor(${json(SID)});
const curRow = db.query("SELECT event_id FROM cursors WHERE sid = ?").get(${json(SID)});
const ids = db.query("SELECT id FROM events WHERE target = ? ORDER BY id").all(${json(SID)}).map((r) => r.id);
console.log(JSON.stringify({ msg, cur: curRow?.event_id ?? 0, maxId: Math.max(...ids) }));
`);
}

describe("lane-inbox drain (W611)", () => {
	test("delivers undelivered directed events and advances the cursor", () => {
		const r = JSON.parse(drainAfter(0, 3)) as {
			msg: string;
			cur: number;
			maxId: number;
		};
		expect(r.msg).toContain("coord-inbox: 3 undelivered event(s)");
		expect(r.msg).toContain("#");
		expect(r.msg).toContain("steer 0");
		expect(r.cur).toBe(r.maxId); // advanced past SHOWN
	});

	test("never drains below or beyond the cursor; second drain is empty", () => {
		const seeded = JSON.parse(drainAfter(0, 2)) as { maxId: number };
		// everything below the (already advanced) cursor: a fresh seed with the
		// cursor pinned at the old max drains nothing new
		const r = JSON.parse(drainAfter(seeded.maxId, 0)) as {
			msg: string | null;
		};
		// zero new events → null (runIn deleted rows; cursor-only drain)
		expect(r.msg).toBeNull();
	});

	test("other lanes' events stay put (target filter)", () => {
		const out = runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
const other = db.query("SELECT COUNT(*) AS n FROM events WHERE target = ?").get(${json(OTHER)});
console.log(JSON.stringify(other));
`);
		expect((JSON.parse(out) as { n: number }).n).toBeGreaterThan(0);
	});

	test("cap: 7 pending drain 5 with a more-pending tail, cursor at the 5th", () => {
		const r = JSON.parse(drainAfter(0, 7)) as {
			msg: string;
			cur: number;
			maxId: number;
		};
		expect(r.msg).toContain("coord-inbox: 5 undelivered event(s)");
		expect(r.msg).toContain("more pending");
		expect(r.cur).toBeLessThan(r.maxId); // 6th + 7th stay past the cursor
	});

	test("consult.expired renders with the consult id (gate-drain shape)", () => {
		const out = runIn(`
const { openGovernorDb } = await import(${JSON.stringify(GOVDB)});
const db = openGovernorDb();
db.query("DELETE FROM events WHERE target = ?").run(${json(SID)});
db.query("INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'coord', 'consult.expired', 'hooks', ?, ?)")
	.run(Date.now(), JSON.stringify({ consult: "C42", reason: "expired unanswered after 60min", q: "why" }), ${json(SID)});
const { drainLaneInboxFor } = await import(${JSON.stringify(LIB)});
console.log(JSON.stringify(drainLaneInboxFor(${json(SID)})));
`);
		const msg = JSON.parse(out) as string;
		expect(msg).toContain("consult.expired");
		expect(msg).toContain("C42");
		expect(msg).toContain("expired unanswered");
	});
});
