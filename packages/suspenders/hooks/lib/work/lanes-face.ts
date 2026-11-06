// hooks/lib/work/lanes-face.ts — W2269.2: the board face of the per-lane
// W892 table (#lanes). Same doctrine as report-face.ts (W1198): this module
// never re-implements a render — reportRows produces the rows,
// buildReportContract produces the ONE versioned contract, and this face
// joins the lane identity (owner sid, session name, liveness verdict,
// launch-failure state) the CLI lane projection carries. The board and the
// CLI cannot disagree because they read the same row set through the same
// contract builder; /api/lanes-table serves this payload.
import type { Database } from "bun:sqlite";
import type {
	LanesCells,
	LanesContract,
	LanesLaneRow,
	LaneLaunchState,
	LaneVerdictWord,
} from "./lanes-contract.ts";
import { laneDegraded } from "./lanes-contract.ts";
import {
	buildReportContract,
	type ReportItem,
	REPORT_SECTIONS,
	type ReportSection,
	reportRows,
} from "./work-report.ts";
import { modelCell, outMinCell, tokensCell } from "./work-report-render.ts";
import { driftAlertLine, readDriftAlerts } from "./lane-drift.ts";
import { type LaneLive, laneLiveRows } from "./work-report-live.ts";
import { resolveBuckleDb } from "../lanes/lane-spend.ts";
import { verdictBySid } from "../lanes/lane-liveness.ts";
import { loadLaneRegistry } from "../lanes/lane-registry.ts";

/** sessions.tags name for a sid (the user-facing lane label; '' = none). */
const sessionName = (db: Database, sid: string): string | null => {
	try {
		const tags = (
			db.query("SELECT tags FROM sessions WHERE sid = ?").get(sid) as {
				tags: string | null;
			} | null
		)?.tags;
		if (!tags) return null;
		const name = (JSON.parse(tags) as { name?: unknown }).name;
		return typeof name === "string" && name ? name : null;
	} catch {
		return null;
	}
};

/** Launch intents for one project: item → attempt/state/requeue. Fail-soft —
 *  a graph without the intents table answers an empty map (launch column
 *  renders absent, never a fabricated 0). */
const launchStates = (
	db: Database,
	project: string,
): Map<string, LaneLaunchState> => {
	const out = new Map<string, LaneLaunchState>();
	try {
		const rows = db
			.query(
				"SELECT item, attempt, state FROM lane_launch_intents WHERE project = ?",
			)
			.all(project) as {
			item: string;
			attempt: number | null;
			state: string;
		}[];
		for (const r of rows)
			out.set(r.item, {
				attempts: Number(r.attempt ?? 0),
				state: String(r.state ?? ""),
				requeueInMs: null,
			});
	} catch {
		// no intents table (fresh graph) — nothing is held or backing off
	}
	return out;
};

/** Runtime guard for the liveness word (verdictBySid's map values are the
 *  tri-state union at runtime; unmatched claims join to nothing → null,
 *  never an invented verdict — W378 honesty). */
const isVerdictWord = (v: unknown): v is Exclude<LaneVerdictWord, null> =>
	v === "alive" || v === "dead" || v === "unknown";

/** Lane rows → the lanes payload. Rows keep contract order (§4
 *  actionable-first); the sid join is owner_sid; live facts ride the same
 *  LaneLive list the verb pins. */
export const lanesFace = (
	db: Database,
	project: string,
	opts: { now?: number; live?: LaneLive[] } = {},
): LanesContract => {
	const now = opts.now ?? Date.now();
	const live = opts.live ?? defaultLive(now);
	const { rows } = reportRows(db, project, { now, live });
	const contract = buildReportContract(rows, { project, now });
	const launches = launchStates(db, project);
	const registry = loadLaneRegistrySafe(project);
	const sids = [
		...new Set(
			rows.map((r) => r.ownerSid).filter((s): s is string => Boolean(s)),
		),
	];
	const verdicts = verdictBySid(sids, registry);
	// W2794: the one drift row set (readDriftAlerts over emitted lane.drift
	// events) — the chips below and the board card render from these SAME
	// rows; the chip join is prefix-tolerant because item.model is the
	// reportModel truncation (MODEL_CAP 16, "+" when several groups) of the
	// alert's full lane_class name.
	const drift = readDriftAlerts(db, project, now);
	const driftLines = drift.map(driftAlertLine);
	const driftClasses = [...new Set(drift.map((a) => a.lane_class))];
	const driftChip = (model: string): string => {
		const m = model.replace(/\+$/, "");
		const hit = driftClasses.find((c) => m.startsWith(c) || c.startsWith(m));
		return hit
			? driftLines.filter((l) => l.startsWith(`${hit} `)).join(" · ")
			: "";
	};
	const sections = Object.fromEntries(
		REPORT_SECTIONS.map((s) => [s, 0]),
	) as Record<ReportSection, number>;
	let failedLanes = 0;
	let worstAttempts = 0;
	const lanes: LanesLaneRow[] = contract.items.map((item) => {
		const sid = rowSid(item, rows);
		const raw = sid === null ? undefined : verdicts.get(sid);
		const launch = launches.get(item.id) ?? null;
		if (launch !== null) {
			failedLanes += 1;
			worstAttempts = Math.max(worstAttempts, launch.attempts);
		}
		sections[item.section] += 1;
		const name = sid === null ? null : sessionName(db, sid);
		const verdict = isVerdictWord(raw) ? raw : null;
		const row = {
			sid,
			name,
			verdict,
			launch,
			item,
			cells: lanesCells(item, sid, name, launch, driftChip(item.model)),
		};
		return { ...row, degraded: laneDegraded(row) };
	});
	return {
		schema_version: 1,
		generated_at: contract.generated_at,
		project,
		now_ms: now,
		stall_ms: contract.stall_ms,
		sections,
		lanes,
		totals: {
			input_tokens: contract.totals.input_tokens,
			output_tokens: contract.totals.output_tokens,
			cache_read_tokens: contract.totals.cache_read_tokens,
			cache_creation_tokens: contract.totals.cache_creation_tokens,
			requests: contract.totals.requests,
		},
		launch_failures: { lanes: failedLanes, worst_attempts: worstAttempts },
		drift: { lines: driftLines, classes: driftClasses },
	};
};

const rowSid = (
	item: ReportItem,
	rows: { id: string; ownerSid: string | null }[],
): string | null => rows.find((r) => r.id === item.id)?.ownerSid ?? null;

/** W2269.2: pre-format the #lanes table cells with the SAME exported
 *  helpers the CLI table renders with — the board renders these strings
 *  verbatim (one cell implementation, CLI and board cannot disagree). */
const lanesCells = (
	item: ReportItem,
	sid: string | null,
	name: string | null,
	launch: LaneLaunchState | null,
	drift: string,
): LanesCells => ({
	sid: name ?? sid ?? "—",
	item: item.id,
	st: `${item.glyph} ${item.status}`,
	task: item.title,
	tokens: tokensCell(item),
	out_min: outMinCell(item),
	model: modelCell(item),
	effort: item.effort ?? "—",
	consult: item.consult ? "Y" : "N",
	launch:
		launch === null
			? ""
			: launch.attempts > 0
				? `launch ×${launch.attempts} · ${launch.state || "held"}`
				: `launch · ${launch.state || "held"}`,
	drift,
});

const defaultLive = (now: number): LaneLive[] => {
	const ledger = resolveBuckleDb();
	return ledger
		? laneLiveRows(ledger, new Date(now - 48 * 3_600_000).toISOString())
		: [];
};

const loadLaneRegistrySafe = (project: string) => {
	try {
		return loadLaneRegistry(project);
	} catch {
		return [];
	}
};
