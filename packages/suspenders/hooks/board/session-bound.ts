// hooks/board/session-bound.ts — which sessions ride every /api/data poll
// (pure: no store, so the unit spec needs no governor home).
import { boardKnob } from "./board-knobs.ts";
import type { SessionView } from "./sessions.ts";

// W685 payload bounds: /api/data served EVERY session ever (1898 rows /
// 423KB) and a labels map mirroring it; the fleet view renders current +
// recent lanes in full and pages history, so the deep tail rode the wire
// for nothing. "Current" = verdict-live, or not CLOSED with a heartbeat
// inside board.session_recent_ms (a never-closed ghost from last month is
// history, not current — 7.5k of them were 2.2MB of every poll); history
// keeps the newest-heartbeat cap. Full history: /api/sessions (paged).
export const SESSION_HISTORY_CAP = 400;

export function boundSessions(
	ss: SessionView[],
	now: number = Date.now(),
): SessionView[] {
	if (ss.length <= SESSION_HISTORY_CAP) return ss;
	const recentMs = boardKnob("board.session_recent_ms");
	const current = (s: SessionView) =>
		s.live || (s.state !== "CLOSED" && s.hb > 0 && now - s.hb <= recentMs);
	const keep = ss.filter(current);
	const history = ss
		.filter((s) => !current(s))
		.sort((a, b) => (b.hb || 0) - (a.hb || 0))
		.slice(0, Math.max(0, SESSION_HISTORY_CAP - keep.length));
	return [...keep, ...history];
}
