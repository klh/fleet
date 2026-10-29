// hooks/board/payload.ts — the /api/data aggregate: the W663 feed memo,
// boundSessions cap, buildPayload stitch, llm routing telemetry, W836 facts
// trust panel. W1255.4: moved verbatim from board/data.ts (per-domain split).
import { observation } from "../lib/observation.ts";
import { plaidStatus } from "../lib/plaid.ts";
import { db } from "./context.ts";
import { laneObservationSnapshot } from "./lane-observations.ts";
import { ago, labelFrom, labelMaps, laneGitSnapshot } from "./lanes.ts";
import { events } from "./events.ts";
import { board, type SessionView } from "./tasks.ts";
import { claims, inbox, laneFacts, sessions } from "./sessions.ts";
import { getObservationRelayStatus } from "./observation-relay.ts";

// W663 follow-up (2026-10-12): the UI polls /api/data + /api/decisions every
// ~1s while one compute costs ~2s (store round-trips on hub bindings) —
// stacked recomputes pushed wire TTFB to 5-7s. One shared memo for the
// /api/data half; the poll storm rides the cache.
// W798: the memo now covers /api/data only — /api/decisions recomputes every
// call. The decisions contract ("fork counts must reflect events the poll
// hasn't seen", routes-data.ts /api/tasks comment) is a freshness contract:
// a 1.5s memo made new forks invisible after emit and answered rows stale
// after POST /api/answer (fixture suite red since the memo landed; W798
// probe: new forks invisible for up to 1.5s).
let _feed: { at: number; data: unknown } | null = null;

let _feedBuilding = false;

const FEED_TTL_MS = 1_500;

function feedMemo(): { at: number; data: unknown } {
	if (!_feed) {
		_feed = { at: Date.now(), data: buildPayload() };
		return _feed;
	}
	// W682: stale-while-revalidate — a poll landing on an expired memo gets
	// the last good payload immediately and the rebuild defers until the
	// response has flushed. The compute is synchronous store RPCs, so a
	// rebuild-in-place stalled every other 1s poll for the cold compute's
	// whole wall time; deferring keeps every poll sub-ms while the ledger
	// staleness stays inside the old worst case (TTL + one compute).
	if (Date.now() - _feed.at >= FEED_TTL_MS && !_feedBuilding) {
		_feedBuilding = true;
		setTimeout(() => {
			try {
				_feed = { at: Date.now(), data: buildPayload() };
			} finally {
				_feedBuilding = false;
			}
		}, 1);
	}
	return _feed;
}

// W28 routing telemetry: today's llm.call events are the routing log;
// per-model token sums vs optional llm.budget.<model> facts are the budgets.
export function llm(): unknown {
	const dayStart = new Date();
	dayStart.setHours(0, 0, 0, 0);
	const calls = (
		db
			.query(
				"SELECT id, ts, payload FROM events WHERE kind = 'llm.call' AND ts >= ? ORDER BY id DESC LIMIT 20",
			)
			.all(dayStart.getTime()) as {
			id: number;
			ts: number;
			payload: string;
		}[]
	).map((c) => ({ id: c.id, ts: c.ts, ...JSON.parse(c.payload) }));
	const rows = db
		.query(
			"SELECT json_extract(payload,'$.model') AS model, COUNT(*) AS calls, SUM(json_extract(payload,'$.tt')) AS tokens FROM events WHERE kind = 'llm.call' AND ts >= ? GROUP BY model ORDER BY tokens DESC",
		)
		.all(dayStart.getTime()) as {
		model: string | null;
		calls: number;
		tokens: number | null;
	}[];
	const budgets = new Map(
		(
			db
				.query("SELECT key, value FROM facts WHERE key LIKE 'llm.budget.%'")
				.all() as { key: string; value: string }[]
		).map((r) => [r.key.slice("llm.budget.".length), Number(r.value)]),
	);
	return {
		calls,
		usage: rows.map((r) => ({
			model: r.model ?? "(unknown)",
			calls: r.calls,
			tokens: r.tokens ?? 0,
			budget: budgets.get(r.model ?? "") ?? null,
		})),
	};
}

// W836 facts trust panel: knowledge-bearing facts (lesson.*/finding.*) with
// the trust marker parsed from the fact's own JSON ({rating, detail,
// evidence, researched}) — the shape the `coord fact` schema note teaches.
// Plain-text facts ride with trust=null (honest: nothing to render).
export function factsTrust(): unknown[] {
	const rows = db
		.query(
			"SELECT key, value, ts FROM facts WHERE key LIKE 'lesson.%' OR key LIKE 'finding.%' ORDER BY ts DESC LIMIT 40",
		)
		.all() as { key: string; value: string; ts: number }[];
	return rows.map((r) => {
		let trust: Record<string, unknown> | null = null;
		try {
			const v: unknown = JSON.parse(r.value);
			if (v && typeof v === "object" && !Array.isArray(v)) {
				const o = v as Record<string, unknown>;
				const take = (k: string): unknown =>
					o[k] != null && o[k] !== "" ? o[k] : undefined;
				const rating = take("rating");
				const detail = take("detail");
				const evidence = take("evidence");
				const researched = take("researched");
				if (
					rating !== undefined ||
					detail !== undefined ||
					evidence !== undefined ||
					researched !== undefined
				)
					trust = { rating, detail, evidence, researched };
			}
		} catch {} // plain-text fact — honest null marker
		return { key: r.key, value: r.value, tsAgo: ago(r.ts), trust };
	});
}

export function payload() {
	return feedMemo().data;
}

// W685 payload bounds: /api/data served EVERY session ever (1898 rows /
// 423KB) and a labels map mirroring it; the fleet view renders current +
// recent lanes in full and pages history, so the deep CLOSED tail rode the
// wire for nothing. Non-CLOSED always ride; CLOSED keeps the newest cap.
const SESSION_HISTORY_CAP = 400;

function boundSessions(ss: SessionView[]): SessionView[] {
	if (ss.length <= SESSION_HISTORY_CAP) return ss;
	const live = ss.filter((s) => s.state !== "CLOSED");
	const closed = ss
		.filter((s) => s.state === "CLOSED")
		.sort((a, b) => b.hbAgo - a.hbAgo)
		.slice(0, SESSION_HISTORY_CAP - Math.min(live.length, SESSION_HISTORY_CAP));
	return [...live, ...closed];
}

function buildPayload(): unknown {
	// W685: sessions ride bounded (see boundSessions) and zombies are cut to
	// the shown-session prefixes — the client zombieFor matches on the same
	// 10-char prefix, so nothing it can render is lost.
	const allSessions = sessions();
	const ss = boundSessions(allSessions);
	const zombiePrefixes = new Set(ss.map((s) => s.sid.slice(0, 10)));
	const labels: Record<string, string> = {};
	for (const s of ss) labels[s.sid] = s.label;
	const lm = labelMaps();
	for (const c of db.query("SELECT DISTINCT sid FROM claims").all() as {
		sid: string;
	}[]) {
		if (!labels[c.sid]) labels[c.sid] = labelFrom(lm, c.sid, "worker");
	}
	const zombies = (
		db
			.query("SELECT key, value FROM facts WHERE key LIKE 'zombie.%'")
			.all() as { key: string; value: string }[]
	)
		.map((z) => ({
			item: z.key.slice("zombie.".length),
			// old monitor versions wrote a leading article — strip it at the boundary
			label: z.value.replace(/^an? /, ""),
		}))
		.filter((z) => zombiePrefixes.has(z.label.slice(0, 10)));
	// consult diagnostics: where inter-agent latency hides; the kb answers
	// repeat questions without spending an expert round-trip
	const byState = db
		.query("SELECT state, COUNT(*) AS n FROM consults GROUP BY state")
		.all() as { state: string; n: number }[];
	const cs = (k: string) => byState.find((b) => b.state === k)?.n ?? 0;
	const kbRow = db
		.query(
			"SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits FROM consult_kb",
		)
		.get() as { n: number; hits: number };
	const consults = {
		open: cs("OPEN"),
		human: cs("ANSWERED"),
		kb: cs("KB"),
		declined: cs("DECLINED"),
		kbSolutions: kbRow.n,
		kbHits: kbRow.hits,
	};
	return {
		ts: Date.now(),
		observation: observation(
			"governor-ledger",
			"work-and-lane-projection",
			"all-projects",
			Date.now(),
			5_000,
			"ledger",
		),
		laneObservations: laneObservationSnapshot(db, null),
		observationRelay: getObservationRelayStatus(),
		sessions: ss,
		sessionsTotal: allSessions.length,
		labels,
		projects: board(),
		claims: claims(),
		events: events(),
		// decisions live in /api/decisions now — this ts lets the UI mark the
		// decisions feed stale without the payload
		decisionsTs: Date.now(),
		zombies,
		consults,
		laneGit: laneGitSnapshot(ss),
		llm: llm(),
		facts: factsTrust(),
		// W911 plaid: the UI-agreement view — same lib the dispatcher reads,
		// live lanes from the session verdicts (the facts, not a file).
		plaid: plaidStatus(
			db,
			allSessions.filter((s) => s.live).map((s) => s.sid),
		),
	};
}

export function payloadFor(sid: string): unknown {
	const base = payload();
	const s = base.sessions.find((x) => x.sid === sid);
	return {
		...base,
		focus: sid,
		focusProject: s?.project ?? null,
		inbox: inbox(sid),
		lane: laneFacts(sid),
	};
}
