// hooks/lib/broadcast-core.ts — W822.1: the BROADCAST insert core, moved
// verbatim from coord/bus.ts so non-coord callers (the work CLI's done
// broadcast) can share it WITHOUT coord/shared.ts's import-time store open.
// Store-first: every entry takes the GovernorStore explicitly — no module
// state, no eager open, so lazy-open CLIs keep their mirror fallback.
import { statSync } from "node:fs";
import type { GovernorStore } from "./govdb.ts";
import { managedSubscriberIdentity } from "./subscribe-attach.ts";

export const LIVE_HEARTBEAT_WINDOW_MS = 30 * 60_000;
// Mirrors govdb.ts's sweepStaleSessions liveTranscript window: a transcript
// (or lane log, for non-Claude dialects) written this recently means the
// process is genuinely still running.
const TRANSCRIPT_LIVE_WINDOW_MS = 15 * 60_000;

export interface LivenessRow {
	sid?: string;
	project?: string | null;
	hb: number;
	parent_sid: string | null;
	role: string | null;
	transcript_path: string | null;
}

// isLiveSession: the ONE "is this RUNNING row actually still alive" check,
// shared by broadcast/targets/message so the three never disagree.
// Liveness term carries HEAD's newer session check (W1261): a live managed
// subscriber identity is decisive for ANY row; stale hb is never death
// evidence by itself.
export function isLiveSession(row: LivenessRow, now = Date.now()): boolean {
	if (row.hb > now - LIVE_HEARTBEAT_WINDOW_MS) return true;
	if (
		row.project != null &&
		row.sid != null &&
		managedSubscriberIdentity(row.project, row.sid) === true
	)
		return true;
	if (row.transcript_path) {
		try {
			return (
				statSync(row.transcript_path).mtimeMs > now - TRANSCRIPT_LIVE_WINDOW_MS
			);
		} catch {
			// transcript missing/unreadable — fall through to the role check
		}
	}
	return row.role === "coordinator";
}

// broadcastNote: one note → one event row per live session (their inbox) +
// the broadcast facts (SessionStart injection covers everyone else). W822.1:
// `extra` rides the payload (the kev= label) so inbox lines carry it, and
// the store arrives as a parameter — the work CLI passes its own lazy handle
// instead of importing the coord face's eagerly-opened one.
export function broadcastNote(
	store: GovernorStore,
	note: string,
	source: string,
	now = Date.now(),
	extra: Record<string, string> = {},
): { id: string; targets: number; deduped?: boolean } {
	// W470: note-dedupe — the same note re-broadcast within 24h returns the
	// earlier broadcast id instead of minting a new one (W438 C7: one note
	// re-minted again and again). SessionStart injection already covers late
	// joiners; a re-broadcast adds nothing but undrainable inbox rows.
	const prior = (
		store
			.query(
				"SELECT payload FROM events WHERE kind = 'BROADCAST' AND ts >= ? ORDER BY id DESC",
			)
			.all(now - 24 * 3_600_000) as { payload: string | null }[]
	).find((r) => {
		try {
			return JSON.parse(r.payload ?? "{}").note === note;
		} catch {
			return false;
		}
	});
	if (prior) {
		const priorId = (JSON.parse(prior.payload ?? "{}") as { id?: string }).id;
		if (priorId) return { id: priorId, targets: 0, deduped: true };
	}
	const bid = `b${now}`;
	const targets = (
		store
			.query(
				"SELECT sid, project, hb, parent_sid, role, transcript_path FROM sessions WHERE state = 'RUNNING'",
			)
			.all() as (LivenessRow & { sid: string })[]
	).filter((row) => isLiveSession(row, now));
	const ins = store.query(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, 'BROADCAST', NULL, ?, ?)",
	);
	for (const target of targets)
		ins.run(
			now,
			source,
			JSON.stringify({ id: bid, note, ...extra }),
			target.sid,
		);
	const upsert = store.query(
		"INSERT INTO facts (key, value, ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts",
	);
	upsert.run(`broadcast.${bid}`, note, now);
	upsert.run(
		"broadcast.latest",
		JSON.stringify({ id: bid, ts: now, note, ...extra }),
		now,
	);
	return { id: bid, targets: targets.length };
}
