// hooks/board/sessions.ts — lane projection: session rows + views, claim
// list, per-lane facts + inbox. W1255.4: moved verbatim from board/data.ts
// (per-domain split, THEN.B).
import { db, type EventRow } from "./context.ts";
import {
	ago,
	decisionVerdicts,
	labelFrom,
	labelMaps,
	laneModelMaps,
} from "./lanes.ts";

// session registry row + the API view the /api/data feed serves
export interface SessionRow {
	sid: string;
	role: string | null;
	state: string;
	parent_sid: string | null;
	project: string | null;
	hb: number;
}

export interface SessionView {
	sid: string;
	label: string;
	role: string | null;
	state: string;
	parent: string | null;
	project: string | null;
	hbAgo: number;
	executor: string | null;
	model: string | null;
	locality: string | null;
	/** W911 plaid route (lane.<sid>.route) — null unless plaid-dispatched. */
	route: string | null;
	// W378 fleet honesty: the shared lane-liveness verdict (board/lanes.ts
	// decisionVerdicts — registry-first `work lanes` truth with the sessions
	// face as fallback) rides every row, so a stale RUNNING session can never
	// paint as working. `live` is the collapsed boolean the UI counts.
	verdict: "alive" | "dead" | "unknown";
	live: boolean;
}

export function sessions(): SessionView[] {
	const lm = labelMaps();
	const laneModel = laneModelMaps();
	const rows = db
		.query(
			"SELECT sid, role, state, parent_sid, project, hb FROM sessions ORDER BY state, sid",
		)
		.all() as SessionRow[];
	const verdicts = decisionVerdicts(
		rows.map((s) => ({ sid: s.sid, project: s.project })),
	);
	return rows.map((s) => ({
		sid: s.sid,
		label: labelFrom(lm, s.sid, s.role),
		role: s.role,
		state: s.state,
		parent: s.parent_sid,
		project: s.project,
		hbAgo: ago(s.hb),
		...(laneModel.get(s.sid) ?? {
			executor: null,
			model: null,
			locality: null,
			route: null,
		}),
		verdict: verdicts.get(s.sid) ?? "unknown",
		live: verdicts.get(s.sid) === "alive",
	}));
}

export function claims(): unknown[] {
	return (
		db
			.query(
				"SELECT sid, scope, intent, hot, ts FROM claims ORDER BY sid, scope",
			)
			.all() as {
			sid: string;
			scope: string;
			intent: string | null;
			hot: number;
			ts: number;
		}[]
	).map((c) => ({
		sid: c.sid,
		scope: c.scope,
		intent: c.intent,
		hot: !!c.hot,
		tsAgo: ago(c.ts),
	}));
}

export function laneFacts(sid: string): Record<string, unknown> {
	const rows = db
		.query("SELECT key, value FROM facts WHERE key = ? OR key = ?")
		.all(`lane.${sid}.state`, `lane.${sid}.capsule`) as {
		key: string;
		value: string;
	}[];
	const out: Record<string, unknown> = {};
	for (const r of rows) {
		const short = r.key.split(".").pop();
		if (short) out[short] = r.value;
	}
	return out;
}

export function inbox(sid: string): unknown[] {
	const cur =
		(
			db.query("SELECT event_id FROM cursors WHERE sid = ?").get(sid) as {
				event_id: number;
			} | null
		)?.event_id ?? 0;
	return (
		db
			.query(
				"SELECT id, ts, source, kind, payload FROM events WHERE target = ? AND id > ? ORDER BY id",
			)
			.all(sid, cur) as EventRow[]
	).map((e) => ({
		id: e.id,
		tsAgo: ago(e.ts),
		source: e.source,
		kind: e.kind,
		note: e.payload,
	}));
}
