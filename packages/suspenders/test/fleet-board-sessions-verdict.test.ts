// fleet-board-sessions-verdict.test.ts — W378: /api/data sessions ride the
// shared lane-liveness verdict. Recipe: fleet-board.test.ts (board fixture:
// scratch HOME + board, direct sqlite seeds against the fixture DB).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { boardFixture } from "./helpers/board-fixture.ts";

setDefaultTimeout(30_000); // spawn-heavy: board fixture + /api/data polls
const { HOME, MY_PROJ, getData } = await boardFixture(0, afterAll);

const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
afterAll(() => db.close());

// W378 shape: three rows the verdict face must split honestly — fresh-hb
// RUNNING rides alive; stale-hb RUNNING with no transcript (the W378 lie
// shape: sessions rows stay RUNNING for dead lanes) rides dead per the
// monitor's own death rule; CLOSED rides dead.
const now = Date.now();
db.query(
	"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('w378-fresh-aaaa', ?, 'worker', ?, ?, 'RUNNING')",
).run(MY_PROJ, now, now);
db.query(
	"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('w378-stale-bbbb', ?, 'worker', ?, ?, 'RUNNING')",
).run(MY_PROJ, now - 50 * 60_000, now - 50 * 60_000);
db.query(
	"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES ('w378-closed-cccc', ?, 'worker', ?, ?, 'CLOSED')",
).run(MY_PROJ, now - 50 * 60_000, now - 50 * 60_000);
console.log(
	"SEEDCOUNT",
	db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number },
);

type SessionFeed = {
	sessions: {
		sid: string;
		state: string;
		verdict: string;
		live: boolean;
	}[];
};

describe("/api/data sessions ride the liveness verdict (W378)", () => {
	test("fresh-hb RUNNING is alive; stale-hb and CLOSED are not", async () => {
		// the board memoizes /api/data for 1.5s (W663) — the fixture's own
		// startup probe cached the pre-seed payload; poll past the TTL
		let d: SessionFeed = { sessions: [] };
		for (let i = 0; i < 20 && !d.sessions.some((s) => s.sid.startsWith("w378-")); i++) {
			d = (await getData()) as SessionFeed;
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(d.sessions.some((s) => s.sid.startsWith("w378-"))).toBe(true);
		const fresh = d.sessions.find((s) => s.sid === "w378-fresh-aaaa");
		const stale = d.sessions.find((s) => s.sid === "w378-stale-bbbb");
		const closed = d.sessions.find((s) => s.sid === "w378-closed-cccc");
		expect(fresh?.verdict).toBe("alive");
		expect(fresh?.live).toBe(true);
		// the W378 lie shape: row says RUNNING, no liveness evidence behind it
		expect(stale?.state).toBe("RUNNING");
		expect(stale?.verdict).toBe("dead");
		expect(stale?.live).toBe(false);
		expect(closed?.verdict).toBe("dead");
		expect(closed?.live).toBe(false);
	});
});

