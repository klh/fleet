// hooks/board/tasks.ts — the work-graph item projection: /api/tasks feed,
// taskShape, dependency splines, spend attribution + series, project kanban.
// W1255.4: moved verbatim from board/data.ts (per-domain split, THEN.B).
import type { Database } from "bun:sqlite";
import { completionTail } from "../lib/work-completion-record.ts";
import {
	type ItemAttribution,
	type ItemSpendPoint,
	itemAttribution,
	itemRequestSpendSeries,
	type LaneRequestSpendRow,
	laneRequestSpendRows,
	resolveBuckleDb,
} from "../lib/lane-spend.ts";
import { preferForProject } from "../lib/prefer.ts";
import { claimWindows, type TimingEventRow } from "../lib/work-timing.ts";
import { utcZ } from "../lib/wallclock.ts";
import { db, type WorkItemRow } from "./context.ts";
import { chunked } from "./helpers.ts";
import {
	ago,
	type TaskSignal,
	laneModelOf,
	ownerLabel,
	payloadOf,
	signalMaps,
	unblockedBy,
} from "./lanes.ts";
import { taskExecutionSnapshot } from "./task-execution.ts";
import { taskTailSnapshot } from "./task-tail.ts";

export function taskShape(
	w: WorkItemRow,
	openDecisions: number,
	unblocked: Map<string, string | null> = new Map(),
	edges: { blocked_by: string[]; waiting_on: string[] } = {
		blocked_by: [],
		waiting_on: [],
	},
	attribution: ItemAttribution | null = null,
	failureNote: string | null = null,
	completion?: Map<string, { text: string; ts: string; source: string }>,
	signal?: TaskSignal | null,
	taskTail?: ReturnType<typeof taskTailSnapshot>,
): Record<string, unknown> {
	// W517 — .prefer tree identity: the stamped tag wins, live resolve
	// covers rows added before coverage; color is a tree attribute, always
	// live (TTL-cached per project in prefer.ts)
	const pref = preferForProject(w.project);
	// W682 — batched callers pass a preloaded completion-tail map (one
	// chunked read for the whole feed); single-item callers keep the direct
	// completionTail() lookup. Missing key = no record, same as null.
	const done =
		w.state === "DONE"
			? completion
				? (completion.get(`${w.project}\u0000${w.id}`) ?? null)
				: completionTail(db, w.project, w.id)
			: null;
	return {
		project: w.project,
		id: w.id,
		title: w.title,
		state: w.state,
		failure_note:
			w.state === "FAILED" || w.state === "WAITING" ? failureNote : null,
		wait_kind: w.wait_kind ?? null,
		wait_reason: w.wait_reason ?? null,
		wait_until_utc: w.wait_until ? utcZ(w.wait_until) : null,
		owner_sid: w.owner_sid ?? null,
		owner_label: ownerLabel(w.owner_sid),
		// W353: the dispatch origin stamp (`work take --origin host:agent`) —
		// the kanban card + drawer template both render t.origin; the feed
		// never carried it, so delegation provenance was invisible in the GUI
		origin: w.origin ?? null,
		tag: w.tags ?? pref.tag,
		tag_color: pref.color,
		requires: w.requires ?? null,
		scope: w.scope ?? null,
		parent_id: w.parent_id ?? null,
		age_s: ago(w.updated_at),
		// W902: absolute stamps travel as UTC ISO-Z; the board chunk renders the
		// viewer-local twin beside them (server never guesses the client TZ)
		created_at_utc: utcZ(w.created_at),
		updated_at_utc: utcZ(w.updated_at),
		open_decisions: openDecisions,
		// W969 Signals-lite verdict (newest lane.signal per item) — the board
		// lanes view badges silent-failure findings beside the tail
		signal: signal ?? null,
		tail:
			done ??
			(taskTail ?? taskTailSnapshot(db, [w]))(
				w,
				w.state === "FAILED" ? 320 : 110,
			)[0] ??
			null,
		...laneModelOf(w.owner_sid),
		unblocked_by:
			w.state === "READY"
				? (unblocked.get(`${String(w.project)}\u0000${String(w.id)}`) ?? null)
				: null,
		blocked_by: edges.blocked_by,
		waiting_on: edges.waiting_on,
		// W776 per-item attribution (buckle spend ⋈ claim windows + wall):
		// raw numbers — the client formats; null when nothing to attribute.
		spend: attribution
			? {
					fresh: attribution.fresh,
					cached: attribution.cached,
					out: attribution.out,
					requests: attribution.requests,
					wall_ms: attribution.wallMs,
					agent_ms: attribution.agentMs,
					model_groups: attribution.groups,
				}
			: null,
	};
}

// W214 dependency splines: per-item unmet work_deps edges (dep state IS NOT
// DONE — NULL-safe so an orphaned dep row still reads blocked) plus
// SHATTERED parents' unfinished required children (rollUp's wait set).
// Keyed project\0id — /api/tasks feeds collide ids across projects (W318).
export function depEdges(): Map<
	string,
	{ blocked_by: string[]; waiting_on: string[] }
> {
	const out = new Map<string, { blocked_by: string[]; waiting_on: string[] }>();
	for (const r of db
		.query(
			"SELECT d.project, d.work_id, d.depends_on FROM work_deps d LEFT JOIN work_items w ON w.id = d.depends_on AND w.project = d.project WHERE w.state IS NOT 'DONE'",
		)
		.all() as { project: string; work_id: string; depends_on: string }[]) {
		const k = `${r.project}\u0000${r.work_id}`;
		const e = out.get(k) ?? { blocked_by: [], waiting_on: [] };
		e.blocked_by.push(r.depends_on);
		out.set(k, e);
	}
	for (const r of db
		.query(
			"SELECT c.project, c.parent_id, c.id FROM work_items c JOIN work_items p ON p.project = c.project AND p.id = c.parent_id WHERE p.state = 'SHATTERED' AND c.parent_id IS NOT NULL AND (c.required IS NULL OR c.required = 1) AND c.state NOT IN ('DONE','SUPERSEDED')",
		)
		.all() as { project: string; parent_id: string; id: string }[]) {
		const k = `${r.project}\u0000${r.parent_id}`;
		const e = out.get(k) ?? { blocked_by: [], waiting_on: [] };
		e.waiting_on.push(r.id);
		out.set(k, e);
	}
	return out;
}

// ONE claim-replay event scan (the W635/W776/W887 attribution inputs) —
// shared by workAttribution + workSpendSeries so each memo window pays a
// single read.
function claimEventScan(): TimingEventRow[] {
	return db
		.query(
			"SELECT project, id, ts, kind, payload FROM events WHERE kind IN ('work.claimed','work.released','work.done','work.failed') ORDER BY ts, id",
		)
		.all() as TimingEventRow[];
}

// W776 — per-item attribution (spend + wall) for the tasks feed, memoized
// 5s: the /api/tasks poll storm rides the cache (W663 doctrine), one ledger
// read per TTL window. Keys are project\0id — W318 id collision.
let _wAttr: { at: number; m: Map<string, ItemAttribution> } | null = null;

const ATTR_TTL_MS = 5_000;

function workAttribution(): Map<string, ItemAttribution> {
	if (_wAttr && Date.now() - _wAttr.at < ATTR_TTL_MS) return _wAttr.m;
	const m = new Map<string, ItemAttribution>();
	// W682: ONE claim-replay bus scan feeds every project's replay — the
	// per-project pair of events scans (25 projects × 2 = 50 store round
	// trips per TTL window) collapses into this single read.
	const evs = claimEventScan();
	for (const { project } of db
		.query("SELECT DISTINCT project FROM work_items")
		.all() as { project: string }[]) {
		for (const [id, a] of itemAttribution(
			db as unknown as Database,
			project,
			Date.now(),
			undefined,
			evs,
		)) {
			m.set(`${project}\u0000${id}`, a);
		}
	}
	_wAttr = { at: Date.now(), m };
	return m;
}

// Per-item one-minute request series for /api/spend-series, memoized 5s like
// workAttribution. Each refresh replaces recent buckets with absolute audit
// totals. The histogram table retains older buckets across board restarts.
let _wSeries: { at: number; m: Map<string, ItemSpendPoint[]> } | null = null;

export function workSpendSeries(): Map<string, ItemSpendPoint[]> {
	if (_wSeries && Date.now() - _wSeries.at < ATTR_TTL_MS) return _wSeries.m;
	const evs = claimEventScan();
	const lastBucket = Number(
		(
			db
				.query("SELECT MAX(bucket_ms) AS t FROM work_spend_histogram")
				.get() as {
				t: number | null;
			} | null
		)?.t ?? 0,
	);
	const fromMs = Math.max(
		Date.now() - 24 * 3_600_000,
		lastBucket ? lastBucket - 2 * 3_600_000 : 0,
	);
	const fromIso = new Date(fromMs).toISOString();
	let rows: LaneRequestSpendRow[] = [];
	try {
		const ledger = resolveBuckleDb();
		rows = ledger ? laneRequestSpendRows(ledger, fromIso) : [];
	} catch {
		rows = []; // unreadable ledger — fail-soft (coord fleet parity)
	}
	const m = new Map<string, ItemSpendPoint[]>();
	const write = db.query(
		"INSERT INTO work_spend_histogram (project,work_id,bucket_ms,fresh,cached,out_tok) VALUES (?,?,?,?,?,?) ON CONFLICT(project,work_id,bucket_ms) DO UPDATE SET fresh=excluded.fresh,cached=excluded.cached,out_tok=excluded.out_tok",
	);
	const newest = db.query(
		"SELECT MAX(bucket_ms) AS t FROM work_spend_histogram WHERE project=? AND work_id=?",
	);
	for (const { project } of db
		.query("SELECT DISTINCT project FROM work_items")
		.all() as { project: string }[]) {
		const { windows } = claimWindows(
			db as unknown as Database,
			project,
			Date.now(),
			evs,
		);
		for (const [id, points] of itemRequestSpendSeries(
			rows,
			windows,
			Number.MAX_SAFE_INTEGER,
		)) {
			const lastWritten = Number(
				(newest.get(project, id) as { t: number | null } | null)?.t ?? 0,
			);
			for (const p of points)
				if (p.t >= lastWritten - 120_000)
					write.run(project, id, p.t, p.fresh, p.cached, p.out);
		}
	}
	for (const r of db
		.query(
			"SELECT project,work_id,bucket_ms,fresh,cached,out_tok FROM work_spend_histogram ORDER BY project,work_id,bucket_ms",
		)
		.all() as {
		project: string;
		work_id: string;
		bucket_ms: number;
		fresh: number;
		cached: number;
		out_tok: number;
	}[]) {
		const key = `${r.project}\u0000${r.work_id}`;
		const points = m.get(key) ?? [];
		points.push({
			t: r.bucket_ms,
			fresh: r.fresh,
			cached: r.cached,
			out: r.out_tok,
		});
		m.set(key, points);
	}
	_wSeries = { at: Date.now(), m };
	return m;
}

/** Persisted per-item one-minute [t, fresh, cached, out] tuples, keyed project\0id. */

export function workSpendSeriesPayload(): Record<
	string,
	[number, number, number, number][]
> {
	const out: Record<string, [number, number, number, number][]> = {};
	for (const [k, points] of workSpendSeries()) {
		out[k] = points.map((p) => [p.t, p.fresh, p.cached, p.out]);
	}
	return out;
}

// the tasks feed: everything not SUPERSEDED (or DONE still holding an owner —
// a stale claim, not a result), newest activity first, open forks counted.
// W682 wire trim: terminal history (DONE/CANCELLED/ORPHANED) caps at the
// newest `done` rows per project — the client kanban renders 12 done cards
// per project and the completed table is opt-in — while live states always
// ride in full. `?done=all` restores the complete feed (the opt-in table).
const TASKS_TERMINAL_STATES = new Set(["DONE", "CANCELLED", "ORPHANED"]);

const TASKS_DONE_CAP_DEFAULT = 12;

// W682 — completion tails batched: one full-table read replaces the per-DONE
// row completionTail() store RPC (~1525 statements per cold /api/tasks
// compute — the profile's whale). Fail-soft like completionRecord: a missing
// table yields an empty map, rows fall through to transcript tails.
function completionTailMap(): Map<
	string,
	{ text: string; ts: string; source: string }
> {
	const out = new Map<string, { text: string; ts: string; source: string }>();
	try {
		for (const r of db
			.query(
				"SELECT project, item, summary, completed_at FROM work_completion_records",
			)
			.all() as {
			project: string;
			item: string;
			summary: string;
			completed_at: number;
		}[])
			out.set(`${r.project}\u0000${r.item}`, {
				text: r.summary,
				ts: new Date(r.completed_at).toISOString(),
				source: "completion",
			});
	} catch {
		// no completion records table (fresh fixture) — tails fall through
	}
	return out;
}

/** Lightweight all-project Work Graph counts for dashboards. */

export function workStateCounts(): Record<string, number> {
	const rows = db
		.query(
			`SELECT w.state AS state,
			CASE WHEN w.state = 'READY' AND EXISTS (
				SELECT 1 FROM work_deps d
				LEFT JOIN work_items dependency ON dependency.project = d.project AND dependency.id = d.depends_on
				WHERE d.project = w.project AND d.work_id = w.id AND dependency.state IS NOT 'DONE'
			) THEN 1 ELSE 0 END AS blocked
		 FROM work_items w WHERE w.state != 'SUPERSEDED'`,
		)
		.all() as { state: string; blocked: number }[];
	const counts = {
		ready: 0,
		working: 0,
		waiting: 0,
		blocked: 0,
		failed: 0,
		done: 0,
	};
	for (const row of rows) {
		if (row.state === "READY") counts[row.blocked ? "blocked" : "ready"] += 1;
		else if (row.state === "CLAIMED" || row.state === "RUNNING")
			counts.working += 1;
		else if (row.state === "SHATTERED" || row.state === "WAITING")
			counts.waiting += 1;
		else if (row.state === "BLOCKED" || row.state === "PAUSED")
			counts.blocked += 1;
		else if (row.state === "FAILED") counts.failed += 1;
		else if (row.state === "DONE") counts.done += 1;
	}
	return counts;
}

export function tasks(
	p: string | null,
	done: number | "all" = TASKS_DONE_CAP_DEFAULT,
): unknown[] {
	const where =
		"state != 'SUPERSEDED' AND NOT (state = 'DONE' AND owner_sid IS NOT NULL)";
	const rows = (
		p && p !== "all"
			? db
					.query(
						`SELECT * FROM work_items WHERE project = ? AND ${where} ORDER BY updated_at DESC`,
					)
					.all(p)
			: db
					.query(
						`SELECT * FROM work_items WHERE ${where} ORDER BY updated_at DESC`,
					)
					.all()
	) as WorkItemRow[];
	const openByTask = new Map<string, number>();
	for (const r of db
		.query(
			"SELECT project, task_id, COUNT(*) AS n FROM decisions WHERE state = 'OPEN' AND task_id IS NOT NULL GROUP BY project, task_id",
		)
		.all() as {
		project: string;
		task_id: string;
		n: number;
	}[])
		openByTask.set(`${r.project}\u0000${r.task_id}`, r.n);
	const unblocked = unblockedBy();
	const edges = depEdges();
	// W682: terminal history caps per project (the client kanban renders 12
	// done cards per project; the completed table opts into the full feed
	// with ?done=all) — the 1.4MB wire was mostly buried DONE rows.
	let feed = rows;
	if (done !== "all") {
		const cap =
			typeof done === "number" && done >= 0 ? done : TASKS_DONE_CAP_DEFAULT;
		const seen = new Map<string, number>();
		feed = rows.filter((w) => {
			if (!TASKS_TERMINAL_STATES.has(w.state)) return true;
			const n = seen.get(w.project) ?? 0;
			if (n >= cap) return false;
			seen.set(w.project, n + 1);
			return true;
		});
	}
	const completion = completionTailMap();
	const signals = signalMaps();
	const execution = taskExecutionSnapshot(db, feed);
	const tail = taskTailSnapshot(db, feed);
	const failures = new Map<string, string>();
	for (const row of db
		.query(
			"SELECT payload FROM events WHERE kind = 'work.failed' ORDER BY ts DESC LIMIT 1000",
		)
		.all() as { payload: string | null }[]) {
		const event = payloadOf(row.payload);
		if (
			typeof event.project === "string" &&
			typeof event.work === "string" &&
			typeof event.note === "string"
		) {
			const key = `${event.project}\u0000${event.work}`;
			if (!failures.has(key)) failures.set(key, event.note);
		}
	}
	return feed.map((w) => ({
		...taskShape(
			w,
			openByTask.get(`${w.project}\u0000${w.id}`) ?? 0,
			unblocked,
			edges.get(`${w.project}\u0000${w.id}`),
			workAttribution().get(`${w.project}\u0000${w.id}`) ?? null,
			failures.get(`${w.project}\u0000${w.id}`) ?? null,
			completion,
			signals.get(`${w.project}\u0000${w.id}`) ?? null,
			tail,
		),
		execution: execution({
			...w,
			open_decisions: openByTask.get(`${w.project}\u0000${w.id}`) ?? 0,
		}),
	}));
}

// W685: batched failNote — newest work.failed payload note per item, one
// IN(...) read for the whole board instead of a store RPC per FAILED row.
function failNoteMaps(works: string[]): Map<string, string | null> {
	const out = new Map<string, string | null>();
	chunked(works, (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(
				`SELECT work, payload FROM events WHERE kind = 'work.failed' AND work IN (${ph}) ORDER BY id DESC`,
			)
			.all(...chunk) as { work: string; payload: string | null }[]) {
			if (!out.has(r.work)) {
				const note = payloadOf(r.payload).note;
				out.set(r.work, note ? String(note).slice(0, 300) : null);
			}
		}
	});
	return out;
}

export function board(): Record<string, unknown>[] {
	const projects = db
		.query(
			"SELECT DISTINCT project FROM work_items WHERE state NOT IN ('DONE','SUPERSEDED') OR state = 'DONE'",
		)
		.all() as { project: string }[];
	// W685: the per-project N+1 (items + deps + failNote per FAILED item)
	// batches into three all-project reads — 136 store RPCs → 4 per compute.
	const items = db
		.query(
			"SELECT project, id, state, owner_sid, origin, title, priority, result_sha, requires, updated_at FROM work_items ORDER BY project, priority DESC, id",
		)
		.all() as (WorkItemRow & { project: string })[];
	const depRows = db
		.query(
			"SELECT project, work_id, depends_on FROM work_deps WHERE depends_on IS NOT NULL AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.project = work_deps.project AND w.id = work_deps.depends_on AND w.state = 'DONE')",
		)
		.all() as { project: string; work_id: string; depends_on: string }[];
	const byProject = new Map<string, WorkItemRow[]>();
	for (const w of items) {
		const list = byProject.get(w.project);
		if (list) list.push(w);
		else byProject.set(w.project, [w]);
	}
	const depsByProject = new Map<
		string,
		{ work_id: string; depends_on: string }[]
	>();
	for (const r of depRows) {
		const list = depsByProject.get(r.project);
		if (list) list.push(r);
		else depsByProject.set(r.project, [r]);
	}
	const failNotes = failNoteMaps(
		items.filter((w) => w.state === "FAILED").map((w) => w.id),
	);
	return projects.map(({ project }) => {
		const items = byProject.get(project) ?? [];
		const doneIds = new Set(
			items.filter((w) => w.state === "DONE").map((w) => w.id),
		);
		const depRows = depsByProject.get(project) ?? [];
		const blocked = new Set(depRows.map((r) => r.work_id));
		const openDeps: Record<string, string[]> = {};
		for (const r of depRows) {
			const deps = openDeps[r.work_id] ?? [];
			deps.push(r.depends_on);
			openDeps[r.work_id] = deps;
		}
		const shape = (w: WorkItemRow) => ({
			id: w.id,
			state: w.state,
			owner: w.owner_sid,
			origin: w.origin,
			title: w.title,
			sha: w.result_sha,
			requires: w.requires,
			blocked: blocked.has(w.id),
			deps: openDeps[w.id] ?? null,
			note: w.state === "FAILED" ? (failNotes.get(w.id) ?? null) : null,
			updatedAgo: ago(w.updated_at),
		});
		return {
			project,
			name:
				project
					.split("/")
					.pop()
					?.replace(/\.git$/, "") ||
				project.split("/").slice(-2, -1).pop() ||
				project,
			doneN: doneIds.size,
			total: items.length,
			pct: items.length ? Math.round((doneIds.size / items.length) * 100) : 0,
			todo: items
				.filter((w) => w.state === "READY" && !blocked.has(w.id))
				.map(shape),
			gated: items
				.filter(
					(w) =>
						(w.state === "READY" && blocked.has(w.id)) ||
						w.state === "BLOCKED" ||
						w.state === "PAUSED" ||
						w.state === "WAITING",
				)
				.map(shape),
			inflight: items
				.filter((w) => w.state === "CLAIMED" || w.state === "RUNNING")
				.map(shape),
			done: items
				.filter((w) => w.state === "DONE")
				.sort((a, b) => b.updated_at - a.updated_at)
				.slice(0, 30)
				.map(shape),
			other: items
				.filter(
					(w) =>
						w.state === "FAILED" ||
						w.state === "CANCELLED" ||
						w.state === "SUPERSEDED" ||
						w.state === "ORPHANED" ||
						w.state === "SHATTERED",
				)
				.map(shape),
		};
	});
}
