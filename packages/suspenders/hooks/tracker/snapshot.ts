// hooks/tracker/snapshot.ts — W575: the tracker's read-only projection of the
// canonical fleet surfaces. Same tables the board GUI reads (work_items,
// claims, sessions, facts, events, work_completion_records) through the same
// store port coord uses (openStore — GOVERNOR_STORE_URL or in-process
// SQLite). No second ledger, no CLI-display parsing, zero writes.
import type { GovernorStore } from "../lib/govdb.ts";
import {
	type LaneRef,
	laneAlive,
	transcriptAlive,
} from "../lib/lane-liveness.ts";
import { loadLaneRegistry } from "../lib/lane-registry.ts";
import {
	type CompletionRecord,
	completionRecord,
} from "../lib/work-completion-record.ts";
import { type CellState, DECISION_KINDS, KINDS } from "./model.ts";

export type { CellState } from "./model.ts";
export { SYMBOLS, stateToCellState } from "./model.ts";

const STALL_LEASE_MS = 15 * 60_000; // the same 15-min reclaim lease `work reclaim` trusts

export interface Transition {
	eventId: number;
	ts: number;
	project: string | null;
	item: string | null; // work-item id when the event kind carries one
	lane: string | null; // lane sid the cell renders in; null → queue column
	state: CellState;
	note: string | null;
}

export interface LaneColumn {
	sid: string;
	name: string; // coord bootstrap --name tag → claim intent → sid8
	sessionState: string | null;
	worktree: string | null;
	live: boolean;
	stalled: boolean; // not live, past the 15-min lease
	unknown: boolean; // verdict undecidable (remote binding / missing evidence)
}

export interface Snapshot {
	columns: LaneColumn[];
	transitions: Transition[]; // bounded history, chronological (id) order
	queueDepth: number;
	now: number;
}

// One read pass over the canonical tables → the tracker's grid model.
// project filter is optional (null = every project, like the board).
// localProbes defaults to the store's own authority: transcript/worktree
// liveness only counts when this process can actually see the host's
// transcripts (the GovernorStore.local law — never guess across hosts).
export function takeSnapshot(
	db: GovernorStore,
	project: string | null,
	history: number,
	now = Date.now(),
	localProbes: boolean = true,
	cwd: string = process.cwd(),
): Snapshot {
	const claims = db
		.query(
			"SELECT sid, scope, intent, ts FROM claims WHERE (?1 IS NULL OR scope = ?1) ORDER BY ts DESC",
		)
		.all(project) as unknown as {
		sid: string;
		scope: string | null;
		intent: string | null;
		ts: number;
	}[];

	// coord bootstrap --name stamps sessions.tags (W293): user-facing names lead
	const nameRows = db
		.query("SELECT sid, tags FROM sessions")
		.all() as unknown as { sid: string; tags: string | null }[];
	const names = new Map<string, string>();
	for (const r of nameRows) {
		const n = tagNameOf(r.tags);
		if (n) names.set(r.sid, n);
	}

	const sessionRows = db
		.query("SELECT sid, hb, state, worktree FROM sessions")
		.all() as unknown as {
		sid: string;
		hb: number;
		state: string;
		worktree: string | null;
	}[];
	const sessions = new Map(sessionRows.map((s) => [s.sid, s]));

	// columns: coordination-plane claims first (claim order), then the owners
	// of CLAIMED/RUNNING items (a `work take` lane owns an item without a
	// claims row). Deduped, in that order — ghost claims surface as stalled.
	const seen = new Set<string>();
	const laneSids: { sid: string; intent: string | null; ts: number }[] = [];
	for (const c of claims) {
		if (!seen.has(c.sid)) {
			seen.add(c.sid);
			laneSids.push(c);
		}
	}
	const ownerRows = db
		.query(
			"SELECT owner_sid, MIN(id) AS item FROM work_items WHERE (?1 IS NULL OR project = ?1) AND state IN ('CLAIMED','RUNNING') AND owner_sid IS NOT NULL GROUP BY owner_sid ORDER BY MAX(updated_at) DESC",
		)
		.all(project) as unknown as { owner_sid: string; item: string }[];
	for (const o of ownerRows) {
		if (!seen.has(o.owner_sid)) {
			seen.add(o.owner_sid);
			laneSids.push({ sid: o.owner_sid, intent: null, ts: 0 });
		}
	}

	// lane registry: THE process-backed liveness surface (`work lanes` rides
	// the same file); missing/unreadable → transcript probes only
	const registry: LaneRef[] = localProbes ? loadLaneRegistry<LaneRef>(cwd) : [];
	const regBySid = new Map(registry.map((r) => [r.sid, r]));

	const columns: LaneColumn[] = laneSids.map((lane) => {
		const c = { sid: lane.sid, intent: lane.intent, ts: lane.ts };
		const sess = sessions.get(c.sid);
		let live = false;
		let unknown = false;
		if (localProbes) {
			// THE liveness chain: registry row → laneAlive (the `work lanes`
			// verdict); no registry row → fresh transcript here; neither →
			// unknown, the mission's explicit undecidable state.
			const reg = regBySid.get(c.sid);
			if (reg) live = laneAlive(reg);
			else if (transcriptProbe(c.sid)) live = true;
			if (!live && sess?.state === "RUNNING") unknown = true;
		} else {
			unknown = true; // remote store binding: no local probe authority
		}
		const settled = now - Math.max(c.ts, sess?.hb ?? 0) > STALL_LEASE_MS;
		return {
			sid: c.sid,
			name: names.get(c.sid) ?? c.intent?.slice(0, 14) ?? c.sid.slice(0, 8),
			sessionState: sess?.state ?? null,
			worktree: sess?.worktree ?? null,
			live,
			stalled: !live && !unknown && settled,
			unknown,
		};
	});

	const queueDepth = (
		db
			.query(
				"SELECT COUNT(*) AS n FROM work_items WHERE (?1 IS NULL OR project = ?1) AND state = 'READY' AND owner_sid IS NULL",
			)
			.get(project) as { n: number }
	).n;

	columns.sort((a, b) => Number(b.live) - Number(a.live)); // live lanes lead

	return {
		columns,
		transitions: recentTransitions(db, project, history, now),
		queueDepth,
		now,
	};
}

// Transcript liveness is test-stubbable (no filesystem in unit tests).
let transcriptProbe: (sid: string) => boolean = transcriptAlive;
export function setTranscriptProbe(fn: (sid: string) => boolean): void {
	transcriptProbe = fn;
}

// Timeline rows: the item-transition event kinds, attributed to lanes.
// Attribution: work.claimed carries `by`; done/failed/… attribute to the
// item's last claimer (releaseClaim runs after the done event fires);
// NEED_DECISION rides its target; consult rows land on the asker.
export function recentTransitions(
	db: GovernorStore,
	project: string | null,
	history: number,
): Transition[] {
	const cap = Math.max(1, history);
	const kinds = [...Object.keys(KINDS), ...DECISION_KINDS];
	const rows = db
		.query(
			`SELECT id, ts, source, kind, scope, payload, target FROM events
			 WHERE kind IN (${kinds.map(() => "?").join(",")})
			 ORDER BY id DESC LIMIT ?`,
		)
		.all(...kinds, cap * 4) as unknown as {
		id: number;
		ts: number;
		source: string;
		kind: string;
		scope: string | null;
		payload: string | null;
		target: string | null;
	}[];
	const lastClaimOf = lastClaimByItem(db);
	const out: Transition[] = [];
	for (const r of rows.reverse()) {
		const p = safeParse(r.payload);
		const item = typeof p?.work === "string" ? p.work : null;
		const itemProject = typeof p?.project === "string" ? p.project : null;
		if (project && itemProject && itemProject !== project) continue;
		let lane: string | null;
		if (r.kind === "NEED_DECISION") {
			lane = r.target;
		} else if (r.kind === "consult" || r.kind === "consult.answer") {
			lane = r.source;
		} else {
			lane =
				typeof p?.by === "string"
					? p.by
					: (lastClaimOf.get(`${itemProject ?? ""}\u0000${item ?? ""}`) ??
						null);
		}
		if (!item && !lane) continue; // neither an item nor a lane → not a cell
		out.push({
			eventId: r.id,
			ts: r.ts,
			project: itemProject,
			item,
			lane,
			state: KINDS[r.kind] ?? "decision",
			note: typeof p?.note === "string" ? p.note : null,
		});
	}
	if (out.length > cap) out.splice(0, out.length - cap); // bounded history
	return out;
}

// item → last claiming lane, so done/failed cells render in the claimer's
// column even though the claim is released after the done event fires.
function lastClaimByItem(db: GovernorStore): Map<string, string> {
	const m = new Map<string, string>();
	const rows = db
		.query("SELECT payload FROM events WHERE kind = 'work.claimed' ORDER BY id")
		.all() as unknown as { payload: string | null }[];
	for (const r of rows) {
		const p = safeParse(r.payload);
		const work = typeof p?.work === "string" ? p.work : null;
		const by = typeof p?.by === "string" ? p.by : null;
		const proj = typeof p?.project === "string" ? p.project : "";
		if (work && by) m.set(`${proj}\u0000${work}`, by);
	}
	return m;
}

function safeParse(s: string | null): Record<string, unknown> | null {
	if (!s) return null;
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// Keyboard inspection target: the immutable work_completion_records row +
// the owning lane's capsule — the permanent summary, not display text.
export interface Detail {
	item: string;
	project: string;
	title: string;
	state: string;
	owner: string | null;
	resultSha: string | null;
	summary: string | null;
	completedBy: string | null;
	completedAt: number | null;
	capsule: string | null;
}

export function itemDetail(
	db: GovernorStore,
	project: string,
	item: string,
): Detail | null {
	const w = db
		.query(
			"SELECT project, id, title, state, owner_sid, result_sha FROM work_items WHERE project = ? AND id = ?",
		)
		.get(project, item) as unknown as
		| {
				project: string;
				id: string;
				title: string;
				state: string;
				owner_sid: string | null;
				result_sha: string | null;
		  }
		| undefined;
	if (!w) return null;
	const rec: CompletionRecord | null = completionRecord(db, project, item);
	let capsule: string | null = null;
	if (w.owner_sid) {
		const cap = db
			.query("SELECT value FROM facts WHERE key = ?")
			.get(`lane.${w.owner_sid}.capsule`) as { value: string } | null;
		capsule = cap?.value ?? null;
	}
	return {
		item: w.id,
		project: w.project,
		title: w.title,
		state: w.state,
		owner: w.owner_sid,
		resultSha: w.result_sha,
		summary: rec?.summary ?? null,
		completedBy: rec?.completed_by ?? null,
		completedAt: rec?.completed_at ?? null,
		capsule,
	};
}

// coord bootstrap --name's tags JSON (sessions.tags), parsed locally so this
// module imports no coord surfaces with db side effects.
function tagNameOf(raw: string | null | undefined): string | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Record<string, unknown>;
		const name = v?.name;
		return typeof name === "string" && name.trim() ? name.trim() : null;
	} catch {
		return null;
	}
}
