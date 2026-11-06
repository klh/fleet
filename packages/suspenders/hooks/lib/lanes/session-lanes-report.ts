// hooks/lib/lanes/session-lanes-report.ts — W2782: the per-session lanes
// table, ONE data source (the lane-liveness line): work-graph claims scoped
// to the session — its own claims plus the lanes it started (sessions
// parent_sid join) — ⋈ the .fleet/lanes.json registry verdict ⋈ W776
// attribution (MODEL/EFFORT). Two carriers render THIS projection: the
// SessionStart bootstrap (the session-scoped table under SUPERVISOR DEFAULT,
// interactive top-level sessions only — explicit worker roles and subagent
// lanes stay exempt, W1124.12) and the fleet-loop cycle-end report (full
// table on delta, one-liner when unchanged, quiet cap — stack conf
// fleet_loop.cycle_report_quiet_s, default 10 minutes).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Table from "cli-table3";
import { laneVerdict, type LaneRef } from "./lane-liveness.ts";
import { readLaneRegistry, type RegistryLane } from "./lane-registry.ts";
import { itemAttribution, type ItemAttribution } from "./lane-spend.ts";
import {
	agentClock,
	compareItemIds,
	REPORT_TABLE_CHARS,
	reportModel,
} from "../work/work-report.ts";

/** Structural db face: satisfies both bun:sqlite Database and GovernorStore
 *  (query().all()/get()) — callers pass whichever they hold. */
type QueryDb = {
	query(sql: string): {
		all(...params: unknown[]): unknown[];
		get(...params: unknown[]): unknown;
	};
};

/** One scoped lane row — the shared shape both carriers render. */
export interface SessionLaneRow {
	sid: string;
	item: string;
	state: string;
	model: string; // "" = unreported (renders —)
	effort: string | null;
	ageMs: number | null;
	lastEvent: string | null;
	lastEventAgoMs: number | null;
	/** registry liveness verdict when the row joined a registry lane; null =
	 *  the session's own claim (its liveness is the session itself) or no
	 *  registry entry. */
	verdict: string | null;
}

// W1131 §3 vocabulary: glyph + word, never colour alone.
const STATE_WORDS: Record<string, string> = {
	READY: "ready",
	CLAIMED: "working",
	RUNNING: "working",
	DONE: "done",
	FAILED: "failed",
	CANCELLED: "cancelled",
	SUPERSEDED: "superseded",
};
const STATE_GLYPHS: Record<string, string> = {
	READY: "·",
	CLAIMED: "◐",
	RUNNING: "◐",
	DONE: "✓",
	FAILED: "✗",
	CANCELLED: "–",
	SUPERSEDED: "–",
};
export const stateGlyphWord = (state: string): string =>
	`${STATE_GLYPHS[state] ?? "·"} ${STATE_WORDS[state] ?? state.toLowerCase()}`;

const verdictSuffix = (r: SessionLaneRow): string =>
	r.verdict !== null && r.verdict !== "alive" ? ` (${r.verdict})` : "";

const COLUMNS = ["SID", "ITEM", "STATE", "MODEL", "EFFORT", "AGE", "LAST"];
const SID_CAP = 20;

/** The ASCII table both carriers render — the W892 fixed-width style (header
 *  row, per-column dash separator, programmatic pads). */
export const renderLanesTable = (rows: SessionLaneRow[]): string => {
	const cells = rows.map((r) => [
		r.sid.length > SID_CAP ? `${r.sid.slice(0, SID_CAP - 1)}…` : r.sid,
		r.item,
		stateGlyphWord(r.state) + verdictSuffix(r),
		r.model || "—",
		r.effort ?? "—",
		r.ageMs == null ? "—" : agentClock(r.ageMs),
		r.lastEvent === null
			? "—"
			: `${r.lastEvent} ${agentClock(r.lastEventAgoMs ?? 0)}`,
	]);
	const widths = COLUMNS.map((h, c) =>
		Math.max(h.length, ...cells.map((row) => row[c].length)),
	);
	const table = new Table({
		chars: REPORT_TABLE_CHARS,
		colAligns: COLUMNS.map(() => "left" as const),
		style: { head: [], border: [], "padding-left": 0, "padding-right": 0 },
	});
	table.push(COLUMNS);
	table.push(widths.map((w) => "-".repeat(w)));
	for (const row of cells) table.push(row);
	return table.toString();
};

type ScopedItem = {
	id: string;
	title: string;
	state: string;
	updated_at: number;
	owner_sid: string;
};
const TERMINAL = "('DONE','CANCELLED','SUPERSEDED','FAILED')";

/** The claim-sid → registry-lane join the fleet faces share (exact sid first,
 *  then the prefix variants — a short claim sid against a long registry sid). */
const findRegistryLane = (
	lanes: readonly RegistryLane[],
	sid: string,
): RegistryLane | undefined =>
	lanes.find((l) => l.sid === sid) ??
	lanes.find((l) => l.sid.startsWith(`${sid}-`) || sid.startsWith(`${l.sid}-`));

/** Bounded last-work-event scan: newest-first over work.* events, first hit
 *  per wanted item wins; items older than the 800-event window render —. */
const lastWorkEvents = (
	db: QueryDb,
	project: string,
	ids: readonly string[],
): Map<string, { kind: string; ts: number }> => {
	const out = new Map<string, { kind: string; ts: number }>();
	if (!ids.length) return out;
	try {
		const rows = db
			.query(
				"SELECT kind, ts, payload FROM events WHERE kind LIKE 'work.%' ORDER BY ts DESC LIMIT 800",
			)
			.all() as { kind: string; ts: number; payload: string }[];
		for (const r of rows) {
			if (out.size === ids.length) break;
			try {
				const p = JSON.parse(r.payload) as {
					work?: string;
					project?: string;
				};
				if (p.project !== project || !p.work || !ids.includes(p.work)) continue;
				if (!out.has(p.work)) out.set(p.work, { kind: r.kind, ts: r.ts });
			} catch {}
		}
	} catch {}
	return out;
};

const attributionOf = (
	db: QueryDb,
	project: string,
	now: number,
): Map<string, ItemAttribution> => {
	try {
		return itemAttribution(db, project, now);
	} catch {
		return new Map(); // fail-soft: a ledger miss never breaks the table
	}
};

const toRow = (
	it: ScopedItem,
	lane: RegistryLane | undefined,
	a: ItemAttribution | undefined,
	ev: { kind: string; ts: number } | undefined,
	now: number,
	self: boolean,
): SessionLaneRow => {
	const ref: LaneRef | undefined =
		lane && !self
			? {
					sid: lane.sid,
					item: lane.item ?? it.id,
					pid: lane.pid,
					worktree: lane.worktree,
					launchedAt: lane.launchedAt,
				}
			: undefined;
	return {
		sid: it.owner_sid,
		item: it.id,
		state: it.state,
		model: reportModel(a?.groups ?? {}),
		effort: a?.effort ?? null,
		ageMs: now - (lane?.launchedAt ?? it.updated_at),
		lastEvent: ev?.kind ?? null,
		lastEventAgoMs: ev ? now - ev.ts : null,
		verdict: ref ? laneVerdict(ref) : null,
	};
};

/** Lanes the session owns or started: own claims + child-lane claims
 *  (sessions.parent_sid join), terminal states excluded. */
export function sessionLaneRows(
	db: QueryDb,
	project: string,
	sid: string,
	cwd: string,
	now = Date.now(),
): SessionLaneRow[] {
	const own = db
		.query(
			`SELECT id, title, state, updated_at, owner_sid FROM work_items WHERE project = ? AND owner_sid = ? AND state NOT IN ${TERMINAL}`,
		)
		.all(project, sid) as ScopedItem[];
	const child = db
		.query(
			`SELECT w.id, w.title, w.state, w.updated_at, w.owner_sid FROM work_items w JOIN sessions s ON s.sid = w.owner_sid AND s.project = w.project WHERE w.project = ? AND s.parent_sid = ? AND w.state NOT IN ${TERMINAL}`,
		)
		.all(project, sid) as ScopedItem[];
	const byId = new Map<string, ScopedItem>();
	for (const r of [...own, ...child]) if (!byId.has(r.id)) byId.set(r.id, r);
	if (!byId.size) return [];
	const attribution = attributionOf(db, project, now);
	const registry = readLaneRegistry(cwd);
	const lanes = registry.known ? registry.lanes : [];
	const last = lastWorkEvents(db, project, [...byId.keys()]);
	const rows: SessionLaneRow[] = [];
	for (const [id, it] of byId)
		rows.push(
			toRow(
				it,
				findRegistryLane(lanes, it.owner_sid),
				attribution.get(id),
				last.get(id),
				now,
				it.owner_sid === sid,
			),
		);
	rows.sort((x, y) => compareItemIds(x.item, y.item));
	return rows;
}

/** The registry-driven projection the fleet-loop cycle renders — the lanes
 *  the loop's dispatch pipeline started (one row per registry lane). */
export function fleetLanesRows(
	db: QueryDb,
	project: string,
	cwd: string,
	now = Date.now(),
): SessionLaneRow[] {
	const registry = readLaneRegistry(cwd);
	if (!registry.known || !registry.lanes.length) return [];
	const attribution = attributionOf(db, project, now);
	const q = db.query(
		`SELECT id, title, state, updated_at, owner_sid FROM work_items WHERE project = ? AND id = ?`,
	);
	const last = lastWorkEvents(
		db,
		project,
		registry.lanes.map((l) => l.item).filter((i): i is string => !!i),
	);
	const rows: SessionLaneRow[] = [];
	for (const lane of registry.lanes) {
		const it = lane.item
			? (q.get(project, lane.item) as ScopedItem | null)
			: null;
		const a = it ? attribution.get(it.id) : undefined;
		const ev = it?.id ? last.get(it.id) : undefined;
		rows.push({
			sid: lane.sid,
			item: lane.item ?? "—",
			state: it?.state ?? "UNKNOWN",
			model: reportModel(a?.groups ?? {}),
			effort: a?.effort ?? null,
			ageMs: lane.launchedAt ? now - lane.launchedAt : null,
			lastEvent: ev?.kind ?? null,
			lastEventAgoMs: ev ? now - ev.ts : null,
			verdict: laneVerdict({
				sid: lane.sid,
				item: lane.item ?? "",
				pid: lane.pid,
				worktree: lane.worktree,
				launchedAt: lane.launchedAt,
			}),
		});
	}
	rows.sort((x, y) => compareItemIds(x.item, y.item));
	return rows;
}

/** The SessionStart bootstrap block: the table, or the one-line no-lanes row
 *  (a session with zero scoped lanes emits it rather than nothing). */
export function sessionLanesBlock(
	db: QueryDb,
	project: string,
	sid: string,
	cwd: string,
	now = Date.now(),
): string[] {
	const rows = sessionLaneRows(db, project, sid, cwd, now);
	if (!rows.length)
		return ["SESSION LANES: none — no lanes riding under this session"];
	const live = rows.filter(
		(r) => r.verdict === null || r.verdict === "alive",
	).length;
	return [
		`SESSION LANES (${rows.length}, ${live} live):`,
		renderLanesTable(rows),
	];
}

// ── cycle-end cadence (the fleet-loop carrier) ──

export interface CycleReportState {
	signature: string;
	lastFullTs: number;
}
export const CYCLE_REPORT_QUIET_DEFAULT_MS = 600_000;

/** Stable-fields digest: sid/item/state/model/effort — age and last-event
 *  tick constantly and must not defeat on-landed-change. */
export const lanesSignature = (rows: SessionLaneRow[]): string =>
	rows
		.map((r) => `${r.sid}|${r.item}|${r.state}|${r.model}|${r.effort}`)
		.join(";");

/** Cadence: full table on signature delta or when the quiet cap passed since
 *  the last full render; one-liner otherwise. */
export function cycleReportDecision(
	prev: CycleReportState | null,
	signature: string,
	now: number,
	quietMs = CYCLE_REPORT_QUIET_DEFAULT_MS,
): { render: "full" | "oneline"; state: CycleReportState } {
	const changed = prev?.signature !== signature;
	const quietCapped = !prev || now - prev.lastFullTs >= quietMs;
	const render = changed || quietCapped ? "full" : "oneline";
	return {
		render,
		state: {
			signature,
			lastFullTs: render === "full" ? now : (prev?.lastFullTs ?? now),
		},
	};
}

const cycleReportStatePath = (repo: string): string =>
	join(repo, ".fleet", "cycle-report.json");

export function readCycleReportState(repo: string): CycleReportState | null {
	try {
		const v = JSON.parse(
			readFileSync(cycleReportStatePath(repo), "utf8"),
		) as Partial<CycleReportState>;
		if (typeof v.signature === "string" && Number.isFinite(v.lastFullTs))
			return { signature: v.signature, lastFullTs: Number(v.lastFullTs) };
	} catch {}
	return null;
}

export function writeCycleReportState(
	repo: string,
	state: CycleReportState,
): void {
	try {
		mkdirSync(join(repo, ".fleet"), { recursive: true });
		writeFileSync(cycleReportStatePath(repo), JSON.stringify(state));
	} catch {} // advisory: a state miss only resets the cadence
}

/** One cycle-end report: null when the registry holds no lanes (the loop
 *  log already says plenty); full table on delta/quiet-cap, one-liner when
 *  unchanged. quietS carries the conf's cycle_report_quiet_s (seconds). */
export function cycleReportBlock(
	db: QueryDb,
	project: string,
	cwd: string,
	prev: CycleReportState | null,
	now = Date.now(),
	quietS?: number,
): { lines: string[]; state: CycleReportState } | null {
	const rows = fleetLanesRows(db, project, cwd, now);
	if (!rows.length) return null;
	const live = rows.filter((r) => r.verdict === "alive").length;
	const quietMs =
		quietS && quietS > 0 ? quietS * 1000 : CYCLE_REPORT_QUIET_DEFAULT_MS;
	const decision = cycleReportDecision(
		prev,
		lanesSignature(rows),
		now,
		quietMs,
	);
	return {
		lines:
			decision.render === "full"
				? [
						`CYCLE-REPORT lanes ${live}/${rows.length} live:`,
						renderLanesTable(rows),
					]
				: [`CYCLE-REPORT lanes ${live}/${rows.length} live — unchanged`],
		state: decision.state,
	};
}
