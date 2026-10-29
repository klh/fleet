// hooks/board/session-bound.e2e.ts — /api/data carries current sessions in
// full plus the newest-heartbeat history cap; month-old never-closed ghosts
// are history, not current.
import { expect, test } from "@playwright/test";
import { boundSessions, SESSION_HISTORY_CAP } from "./session-bound.ts";

const now = 10_000_000_000;
const DAY = 86_400_000;
const row = (sid, state, hb, live = false) => ({
	sid,
	label: sid,
	role: null,
	state,
	parent: null,
	project: null,
	hb,
	hbAgo: Math.round((now - hb) / 1000),
	executor: null,
	model: null,
	locality: null,
	route: null,
	verdict: live ? "alive" : "dead",
	live,
});

test.describe("@unit", () => {
	test("under the cap everything rides", () => {
		const ss = [row("a", "CLOSED", now - 9 * DAY)];
		expect(boundSessions(ss, now)).toBe(ss);
	});

	test("live + recent non-CLOSED ride; ghosts and CLOSED fill the newest cap", () => {
		const ghosts = Array.from({ length: 2000 }, (_, i) =>
			row(`ghost${i}`, "RUNNING", now - 30 * DAY - i * 1000),
		);
		const closed = Array.from({ length: 500 }, (_, i) =>
			row(`closed${i}`, "CLOSED", now - 2 * DAY - i * 1000),
		);
		const current = [
			row("live-old", "RUNNING", now - 40 * DAY, true),
			row("recent", "IDLE", now - 60_000),
		];
		const out = boundSessions([...ghosts, ...closed, ...current], now);
		expect(out).toHaveLength(SESSION_HISTORY_CAP);
		const sids = out.map((s) => s.sid);
		expect(sids.slice(0, 2)).toEqual(["live-old", "recent"]);
		// newest heartbeat first: the 2-day-old CLOSED rows beat 30-day ghosts
		expect(sids[2]).toBe("closed0");
		expect(sids.filter((s) => s.startsWith("ghost"))).toEqual([]);
	});

	test("the recent window is the board.session_recent_ms knob", () => {
		process.env.SUSPENDERS_BOARD_SESSION_RECENT_MS = String(60 * DAY);
		try {
			const ghosts = Array.from({ length: 450 }, (_, i) =>
				row(`g${i}`, "RUNNING", now - 30 * DAY - i),
			);
			expect(boundSessions(ghosts, now)).toHaveLength(450);
		} finally {
			delete process.env.SUSPENDERS_BOARD_SESSION_RECENT_MS;
		}
	});
});
