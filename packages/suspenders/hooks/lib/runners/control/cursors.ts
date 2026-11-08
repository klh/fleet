// cursors.ts — W2869.2: per-reader event feed + per-reader read cursors.
// The pattern is the coord bus examined-advance (hooks/coord/bus.ts): a
// reader's cursor only ever moves PAST rows it has actually been handed;
// a filtered row can never be re-seen. Replay is exact and reconnect
// resumes at the reader's own cursor. Detach is a read-only close: it
// never aborts or parks the job it watched.
import type { RunnerStore } from "./store.ts";

const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS runner_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
)`;
const EVENTS_IDX_DDL =
	"CREATE INDEX IF NOT EXISTS runner_events_run_idx ON runner_events (run_id, id)";
const READERS_DDL = `
CREATE TABLE IF NOT EXISTS runner_readers (
	run_id TEXT NOT NULL,
	reader_sid TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('reading','detached')),
	cursor INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (run_id, reader_sid)
)`;

export interface RunnerEvent {
	id: number;
	run_id: string;
	kind: string;
	payload_json: string;
	created_at: number;
}

export interface ReaderRow {
	run_id: string;
	reader_sid: string;
	state: "reading" | "detached";
	cursor: number;
	updated_at: number;
}

export const ensureRunnerReaderSchema = (store: RunnerStore): void => {
	store.run(EVENTS_DDL);
	store.run(EVENTS_IDX_DDL);
	store.run(READERS_DDL);
};

export const recordRunnerEvent = (
	store: RunnerStore,
	input: { runId: string; kind: string; payload: unknown; now: number },
): RunnerEvent => {
	const payload_json = JSON.stringify(input.payload);
	const res = store.run(
		"INSERT INTO runner_events (run_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
		input.runId,
		input.kind,
		payload_json,
		input.now,
	);
	return {
		id: res.lastInsertRowid,
		run_id: input.runId,
		kind: input.kind,
		payload_json,
		created_at: input.now,
	};
};

const readerRow = (
	store: RunnerStore,
	runId: string,
	readerSid: string,
): ReaderRow | null =>
	store.get<ReaderRow>(
		"SELECT * FROM runner_readers WHERE run_id = ? AND reader_sid = ?",
		runId,
		readerSid,
	);

const eventsSince = (
	store: RunnerStore,
	runId: string,
	cursor: number,
): RunnerEvent[] =>
	store.all<RunnerEvent>(
		"SELECT * FROM runner_events WHERE run_id = ? AND id > ? ORDER BY id",
		runId,
		cursor,
	);

/** Attach (or re-attach) a reader. First attach seeds the cursor at
 *  fromCursor (the job's cursor_base — since-last-committed); a
 *  re-attach KEEPS the reader's own cursor so reconnect replays exactly
 *  the unread suffix. Returns everything unread right now. */
export function attachReader(
	store: RunnerStore,
	input: { runId: string; readerSid: string; fromCursor: number; now: number },
): { cursor: number; events: RunnerEvent[] } {
	const existing = readerRow(store, input.runId, input.readerSid);
	const cursor = existing ? existing.cursor : input.fromCursor;
	store.run(
		`INSERT INTO runner_readers (run_id, reader_sid, state, cursor, updated_at)
		 VALUES (?, ?, 'reading', ?, ?)
		 ON CONFLICT(run_id, reader_sid) DO UPDATE SET state = 'reading', updated_at = excluded.updated_at`,
		input.runId,
		input.readerSid,
		cursor,
		input.now,
	);
	return { cursor, events: eventsSince(store, input.runId, cursor) };
}

/** Replay: hand the reader everything past its cursor, then advance the
 *  cursor to the last handed id — examined-advance, so a filtered row
 *  can never be re-seen. */
export function replayReader(
	store: RunnerStore,
	input: { runId: string; readerSid: string; now: number },
): { cursor: number; events: RunnerEvent[] } {
	const row = readerRow(store, input.runId, input.readerSid);
	const cursor = row ? row.cursor : 0;
	const events = eventsSince(store, input.runId, cursor);
	const next = events.length > 0 ? events[events.length - 1].id : cursor;
	if (row) {
		store.run(
			"UPDATE runner_readers SET cursor = ?, updated_at = ? WHERE run_id = ? AND reader_sid = ?",
			next,
			input.now,
			input.runId,
			input.readerSid,
		);
	}
	return { cursor: next, events };
}

/** Read-only close — never aborts or parks the job it watched. */
export const detachReader = (
	store: RunnerStore,
	input: { runId: string; readerSid: string; now: number },
): void => {
	store.run(
		"UPDATE runner_readers SET state = 'detached', updated_at = ? WHERE run_id = ? AND reader_sid = ?",
		input.now,
		input.runId,
		input.readerSid,
	);
};
