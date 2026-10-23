// hooks/lib/report-face.ts — W1198: the board face of THE work-report
// table. The CLI face stays the ONE renderer (W913): this module calls
// lib/work-report.ts — reportRows for the row set, buildReportTable for
// the exact fixed-width pads — it never re-implements the table. The
// board pane consumes the payload (table + per-row stamps) via /api/report.
import type { Database } from "bun:sqlite";
import {
	buildReportTable,
	type ReportRow,
	reportLetter,
	reportRows,
	TASK_CAP,
} from "./work-report.ts";

/** One expandable row of the pane: the report cells live in `table` (the
 *  verbatim renderer output); a row carries its expand key + live stamp. */
export interface ReportFaceRow {
	id: string;
	st: string;
	title: string;
	lastEventTs: number | null;
}

export interface ReportFace {
	ts: number;
	project: string;
	/** THE work-report table — buildReportTable output, byte-for-byte. */
	table: string;
	rows: ReportFaceRow[];
}

/** work id -> latest event ts, read off the W-shredded `work` column
 *  (events-shred keeps work = json_extract(payload,'$.work')). Fail-soft
 *  like consultedItems: pre-shred or test-schema dbs answer an empty map. */
export const lastEventMap = (
	db: Database,
	project: string,
): Map<string, number> => {
	try {
		const rows = db
			.query(
				"SELECT work, MAX(ts) AS t FROM events WHERE project = ? AND work IS NOT NULL GROUP BY work",
			)
			.all(project) as { work: string | null; t: number | null }[];
		const out = new Map<string, number>();
		for (const r of rows) if (r.work && r.t != null) out.set(r.work, r.t);
		return out;
	} catch {
		return new Map();
	}
};

/** The board payload for the live table: the CLI row set + the CLI pads +
 *  per-row last-event stamps. `opts.ledger` hermetically pins spend (tests). */
export const reportFace = (
	db: Database,
	project: string,
	opts: { now?: number; ledger?: string | null } = {},
): ReportFace => {
	const now = opts.now ?? Date.now();
	const { rows } = reportRows(db, project, {
		now,
		...("ledger" in opts ? { ledger: opts.ledger } : {}),
	});
	const last = lastEventMap(db, project);
	return {
		ts: now,
		project,
		table: buildReportTable(rows),
		rows: rows.map((r: ReportRow) => ({
			id: r.id,
			st: reportLetter(r.state),
			title: r.title.slice(0, TASK_CAP),
			lastEventTs: last.get(r.id) ?? null,
		})),
	};
};

/** Default scope for the pane: the most recently touched graph. The board
 *  process cwd is not trusted (launchd cwd); ?project= overrides. */
export const reportDefaultProject = (db: Database): string | null => {
	try {
		const r = db
			.query("SELECT project FROM work_items ORDER BY updated_at DESC LIMIT 1")
			.get() as { project: string | null } | null;
		return r?.project ?? null;
	} catch {
		return null;
	}
};

/** Per-row expand payload (mission item 2): the item, its last event stamp,
 *  and the lane's current turn/tool via an injectable transcript tail (the
 *  route binds board transcriptTailAll; tests bind a stub). */
export const reportRowDetail = (
	db: Database,
	project: string,
	id: string,
	tail: (sid: string | null) => { text: string; ts: string | null }[],
): {
	id: string;
	state: string;
	title: string;
	ownerSid: string | null;
	lastEventTs: number | null;
	laneTail: { text: string; ts: string | null }[];
} | null => {
	const w = db
		.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
		.get(project, id) as {
		state: string;
		title: string;
		owner_sid: string | null;
	} | null;
	if (!w) return null;
	return {
		id,
		state: w.state,
		title: w.title,
		ownerSid: w.owner_sid,
		lastEventTs: lastEventMap(db, project).get(id) ?? null,
		laneTail: tail(w.owner_sid),
	};
};
