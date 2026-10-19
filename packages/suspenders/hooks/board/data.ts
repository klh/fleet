import { usableRecommendation } from "../lib/advice-quality.ts";
import { completionTail } from "../lib/work-completion-record.ts";
import { claimWindows, type TimingEventRow } from "../lib/work-timing.ts";

// hooks/board/data.ts — the /api data builders: tasks, board, claims, decisions, activity (W157 board split).
// Pieces moved verbatim from bin/fleet-board.ts; exports widened so
// sibling modules and the route modules import them.

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { readRegistry } from "../lib/hub-locate.ts";
import {
	ATTRIBUTION_LOOKBACK_MS,
	type ItemAttribution,
	type ItemSpendPoint,
	itemAttribution,
	type LaneSpendRow,
	itemSpendSeries,
	laneSpendRows,
	resolveBuckleDb,
} from "../lib/lane-spend.ts";
import { observation } from "../lib/observation.ts";
// W911: the plaid UI-agreement view — one shape for dispatch + board.
import { plaidStatus } from "../lib/plaid.ts";
import { preferForProject } from "../lib/prefer.ts";
import { utcZ } from "../lib/wallclock.ts";
import { darkHubNow } from "../lib/stack-config.ts";
import {
	BIND,
	db,
	gatePath,
	LLM_ORIGIN,
	REG_DIR,
	sessionStartPath,
} from "./context.ts";
import { collapseDups } from "./decision-dups.ts";
import { chunked } from "./helpers.ts";
import { laneObservationSnapshot } from "./lane-observations.ts";
import {
	ago,
	decisionVerdicts,
	labelFrom,
	labelMaps,
	laneGitSnapshot,
	laneModelMaps,
	laneModelOf,
	ownerLabel,
	payloadOf,
	projOf,
	subscribeTail,
	syncDecisions,
	transcriptTail,
	unblockedBy,
} from "./lanes.ts";
import { getObservationRelayStatus } from "./observation-relay.ts";

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
		failure_note: w.state === "FAILED" ? failureNote : null,
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
		tail:
			done ??
			transcriptTail(w.owner_sid, w.state === "FAILED" ? 320 : 110) ??
			subscribeTail(w.owner_sid),
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

// W887 — per-item spend-over-time for /api/spend-series, memoized 5s like
// workAttribution (W663: the sparkline poll rides the cache; laneSpendRows
// is project-independent so ONE ledger read feeds every project).
let _wSeries: { at: number; m: Map<string, ItemSpendPoint[]> } | null = null;
export function workSpendSeries(): Map<string, ItemSpendPoint[]> {
	if (_wSeries && Date.now() - _wSeries.at < ATTR_TTL_MS) return _wSeries.m;
	const evs = claimEventScan();
	const fromBucket = `${new Date(Date.now() - ATTRIBUTION_LOOKBACK_MS).toISOString().slice(0, 13)}:00`;
	let rows: LaneSpendRow[] = [];
	try {
		const ledger = resolveBuckleDb();
		rows = ledger ? laneSpendRows(ledger, fromBucket) : [];
	} catch {
		rows = []; // unreadable ledger — fail-soft (coord fleet parity)
	}
	const m = new Map<string, ItemSpendPoint[]>();
	for (const { project } of db
		.query("SELECT DISTINCT project FROM work_items")
		.all() as { project: string }[]) {
		const { windows } = claimWindows(
			db as unknown as Database,
			project,
			Date.now(),
			evs,
		);
		for (const [id, points] of itemSpendSeries(rows, windows)) {
			m.set(`${project}\u0000${id}`, points);
		}
	}
	_wSeries = { at: Date.now(), m };
	return m;
}

/** W887 — wire shape for /api/spend-series: per-item [t, fresh, cached, out]
 *  tuples keyed project\0id (W318). Tuples keep the poll payload tight. */
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
	return feed.map((w) =>
		taskShape(
			w,
			openByTask.get(`${w.project}\u0000${w.id}`) ?? 0,
			unblocked,
			edges.get(`${w.project}\u0000${w.id}`),
			workAttribution().get(`${w.project}\u0000${w.id}`) ?? null,
			failures.get(`${w.project}\u0000${w.id}`) ?? null,
			completion,
		),
	);
}

// the drawer's event feed: last 50 events tied to the item — payload.work
// match (project-stamped) or scope match, newest first
export function workEvents(p: string, id: string): unknown[] {
	return (
		db
			.query(
				`SELECT id, ts, source, kind, payload FROM events
				WHERE (work = ? AND project = ?)
					OR (scope = ? AND project = ?)
				ORDER BY id DESC LIMIT 50`,
			)
			.all(id, p, id, p) as EventRow[]
	).map((e) => {
		const pl = payloadOf(e.payload);
		return {
			id: e.id,
			ts: e.ts,
			kind: e.kind,
			source: e.source,
			note: pl.note != null ? String(pl.note) : null,
			sha: pl.sha != null ? String(pl.sha) : null,
		};
	});
}

// decisions linked to the item, any state — the drawer shows the full story
export function taskDecisions(p: string, id: string): unknown[] {
	return (
		db
			.query(
				"SELECT event_id, state, question, answer_note FROM decisions WHERE project = ? AND task_id = ? ORDER BY event_id DESC",
			)
			.all(p, id) as {
			event_id: number;
			state: string;
			question: string | null;
			answer_note: string | null;
		}[]
	).map((d) => ({
		event_id: d.event_id,
		state: d.state,
		question: d.question ?? "",
		answer_note: d.answer_note ?? null,
	}));
}

// newest-first bus feed. note/sha ride the payload; project too (CLI emitters
// stamp it — the source session's project covers anything older). Keyset
// pagination (W451): `before` is the previous page's last id — the caller
// drains history with ?before=<nextCursor>; a partial page means the end.
export function activity(
	p: string | null,
	limit: number,
	before?: number,
): { events: unknown[]; nextCursor: number | null } {
	const hasCursor = typeof before === "number" && Number.isFinite(before);
	const cursorSql = hasCursor ? " AND id < ?" : "";
	const evs = (
		p && p !== "all"
			? db
					.query(
						`SELECT id, ts, source, kind, payload, target FROM events
					WHERE (project = ?
						OR (project IS NULL AND source IN (SELECT sid FROM sessions WHERE project = ?)))${cursorSql}
					ORDER BY id DESC LIMIT ?`,
					)
					.all(...(hasCursor ? [p, p, before, limit] : [p, p, limit]))
			: db
					.query(
						`SELECT id, ts, source, kind, payload, target FROM events WHERE 1=1${cursorSql} ORDER BY id DESC LIMIT ?`,
					)
					.all(...(hasCursor ? [before, limit] : [limit]))
	) as EventRow[];
	const rows = evs.map((e) => {
		const pl = payloadOf(e.payload);
		return {
			id: e.id,
			ts: e.ts,
			kind: e.kind,
			source: e.source,
			target: e.target ?? null,
			note: pl.note != null ? String(pl.note) : null,
			sha: pl.sha != null ? String(pl.sha) : null,
			project: pl.project ?? projOf(e.source) ?? null,
		};
	});
	return {
		events: rows,
		nextCursor: evs.length === limit ? (evs[evs.length - 1]?.id ?? null) : null,
	};
}

// advisory wiring checks — never throw; a failed check is information, not an
// error. settings.json hook commands may spell $HOME literally — expand before
// comparing against this install's script paths.
export function settingsCommands(kind: string): string[] {
	try {
		const s = JSON.parse(
			readFileSync(`${process.env.HOME}/.claude/settings.json`, "utf8"),
		) as {
			hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
		};
		return (s?.hooks?.[kind] ?? [])
			.flatMap((m) => (m?.hooks ?? []).map((h) => String(h?.command ?? "")))
			.map((c) => c.replaceAll("$HOME", process.env.HOME ?? "~"));
	} catch {
		return [];
	}
}

// W852: the advice endpoint is a belt specialist whose residency is the
// machine's tier manifest (belt bin/registry-emit.ts `tier` → tier.json,
// warm_ports; llm-keepwarm reads the same file). At BELT_TIER=minimal the
// default :8901 coder is NOT resident, so a healthy minimal fleet painted
// FAIL — the endpoint loads on first use instead. Precedence mirrors belt's
// resolveTier: BELT_TIER env → manifest → full.
const TIER_MANIFEST_PATH = () =>
	process.env.BELT_TIER_MANIFEST ??
	`${process.env.HOME}/.claude/local-llm/tier.json`;

// keepwarm's fail-safe set (hooks/bin/llm-keepwarm.ts) — the ≤4GB residents
const MINIMAL_FALLBACK_PORTS = [8902, 8913];

export function tierFacts(): { tier: string; warmPorts: number[] } {
	let tier =
		process.env.BELT_TIER === "minimal" || process.env.BELT_TIER === "full"
			? process.env.BELT_TIER
			: "full";
	let warmPorts: number[] = [];
	try {
		const doc = JSON.parse(readFileSync(TIER_MANIFEST_PATH(), "utf8")) as {
			tier?: string;
			warm_ports?: unknown;
		};
		if (tier === "full" && (doc.tier === "minimal" || doc.tier === "full"))
			tier = doc.tier;
		if (Array.isArray(doc.warm_ports))
			warmPorts = doc.warm_ports.filter(
				(p): p is number => typeof p === "number" && p > 0 && p < 65536,
			);
	} catch {
		// no manifest / unreadable → env tier or full, no on-demand excuse
	}
	if (tier === "minimal" && !warmPorts.length)
		warmPorts = MINIMAL_FALLBACK_PORTS;
	return { tier, warmPorts };
}

const probeModels = async (origin: string, ms: number): Promise<boolean> => {
	try {
		const r = await fetch(`${origin}/v1/models`, {
			signal: AbortSignal.timeout(ms),
		});
		return r.ok;
	} catch {
		return false;
	}
};

export async function llmCheck(): Promise<{ ok: boolean; detail: string }> {
	const direct = await probeModels(LLM_ORIGIN, 1500);
	if (direct) return { ok: true, detail: `${LLM_ORIGIN} answers` };
	const { tier, warmPorts } = tierFacts();
	// full tier: the endpoint IS resident, when a resident endpoint is down
	// it is down. minimal tier: the advice target loads on demand — the
	// resident swarm answering is what matters (W852 owner complaint).
	if (tier !== "minimal" || !warmPorts.length)
		return { ok: false, detail: `no answer from ${LLM_ORIGIN} within 1.5s` };
	const up = (
		await Promise.all(
			warmPorts.map((p) => probeModels(`http://127.0.0.1:${p}`, 1000)),
		)
	)
		.map((ok, i) => (ok ? warmPorts[i] : 0))
		.filter(Boolean);
	if (!up.length)
		return {
			ok: false,
			detail: `${LLM_ORIGIN} down and the resident swarm (${warmPorts.join(", ")}) silent`,
		};
	return {
		ok: true,
		detail: `${LLM_ORIGIN} is on-demand (tier manifest) — resident swarm ${up.join(", ")} answers; advice works, first use pays a model-load stall`,
	};
}

// W852 — hub reachability: one bounded probe per configured hub (first
// candidate — the registry is precedence-ordered), hubs inside a stack.yaml
// dark window are EXPECTED down (NAS nightly poweroff, W483) and skip the
// probe. No registry = no hubs configured, trivially ok.
const probeHub = async (base: string): Promise<boolean> => {
	try {
		await fetch(`${base.replace(/\/$/, "")}/api/health`, {
			signal: AbortSignal.timeout(1200),
		});
		return true;
	} catch {
		return false;
	}
};

async function hubCheck(): Promise<{ ok: boolean; detail: string }> {
	const reg = readRegistry();
	const entries = Object.entries(reg).filter(([label]) => label.trim());
	if (!entries.length) return { ok: true, detail: "no hubs configured" };
	return probeHubRows(entries);
}

async function probeHubRows(
	entries: [string, { candidates?: string[] }][],
): Promise<{ ok: boolean; detail: string }> {
	const rows = await Promise.all(
		entries.map(async ([label, entry]) => {
			const url = entry?.candidates?.[0];
			if (!url) return { ok: true, detail: `${label}: no candidates listed` };
			if (darkHubNow(label))
				return { ok: true, detail: `${label}: dark window (expected down)` };
			const up = await probeHub(url);
			return {
				ok: up,
				detail: up ? `${label} answers` : `${label} no answer at ${url}`,
			};
		}),
	);
	const down = rows.filter((r) => !r.ok);
	return {
		ok: down.length === 0,
		detail:
			down.map((r) => r.detail).join("; ") ||
			rows.map((r) => r.detail).join("; "),
	};
}

export async function setupChecks(): Promise<unknown[]> {
	const [llm, hubs] = await Promise.all([llmCheck(), hubCheck()]);
	// wired = a registered command runs the hook BY NAME — the install layout
	// varies (namespaced suspenders/ vs legacy hooks/), so a literal-path match
	// false-negatived every non-namespaced machine
	const hookOk = settingsCommands("PreToolUse").some((c) =>
		c.includes("gate.ts"),
	);
	const startOk = settingsCommands("SessionStart").some((c) =>
		c.includes("session-start.ts"),
	);
	// W852 — the install's activation receipt (~/.config/klh/service-activation.json,
	// SERVICE-ACTIVATION.md): blessed intent for every launchd unit this install
	// registered. Unreadable/empty = install-grade wiring is missing.
	const ACTIVATION_RECEIPT = `${process.env.HOME}/.config/klh/service-activation.json`;
	let activationOk = false;
	let activationDetail =
		"no readable receipt at ~/.config/klh/service-activation.json";
	try {
		const doc = JSON.parse(readFileSync(ACTIVATION_RECEIPT, "utf8")) as {
			services?: unknown[];
		};
		const n = Array.isArray(doc.services) ? doc.services.length : 0;
		if (n > 0) {
			activationOk = true;
			activationDetail = `receipt blessed ${n} services`;
		}
	} catch {
		// missing/unreadable — surfaced as the check's FAIL + fix
	}
	// W852 — the board's own launchd unit: a server cannot paint itself
	// healthy (owner law), so the check is the UNIT is installed, not the
	// process — the answering process IS this board.
	const boardPlist = `${process.env.HOME}/Library/LaunchAgents/com.suspenders.board.plist`;
	const boardOk = existsSync(boardPlist);
	// W882 — the W779 heartbeat fold: maintenance cadence lives in the ONE
	// com.suspenders.fleet-loop unit (services.yaml:144). The retired
	// monitor-agent plists ride the legacyLabels boot-out list
	// (services.yaml:292) — installs remove them, so they are never checked.
	const fleetLoopPlist = `${process.env.HOME}/Library/LaunchAgents/com.suspenders.fleet-loop.plist`;
	const fleetLoopOk = existsSync(fleetLoopPlist);
	return [
		{
			id: "db",
			label: "Control-plane database",
			ok: true,
			detail: `${REG_DIR}/governor.db`,
			fix: null,
		},
		{
			id: "hooks-wired",
			label: "Hook gates wired",
			ok: hookOk,
			detail: hookOk
				? gatePath
				: `PreToolUse hooks in ~/.claude/settings.json do not reference ${gatePath}`,
			fix: hookOk ? null : "./install.sh --wire",
		},
		{
			id: "session-start",
			label: "Session injection wired",
			ok: startOk,
			detail: startOk
				? sessionStartPath
				: `SessionStart hooks in ~/.claude/settings.json do not reference ${sessionStartPath}`,
			fix: startOk ? null : "./install.sh --wire",
		},
		{
			id: "fleet-loop",
			label: "Fleet-loop heartbeat unit",
			ok: fleetLoopOk,
			detail: fleetLoopOk
				? "com.suspenders.fleet-loop launchd unit installed"
				: "no com.suspenders.fleet-loop plist in ~/Library/LaunchAgents",
			fix: fleetLoopOk ? null : "./install.sh --with-launchd",
		},
		{
			id: "activation",
			label: "Service activation receipt",
			ok: activationOk,
			detail: activationDetail,
			fix: activationOk ? null : "./install.sh --with-launchd",
		},
		{
			id: "board-unit",
			label: "Board service unit",
			ok: boardOk,
			detail: boardOk
				? "com.suspenders.board launchd unit installed"
				: "no com.suspenders.board plist in ~/Library/LaunchAgents",
			fix: boardOk ? null : "./install.sh --with-launchd",
		},
		{
			id: "llm",
			label: "Advice LLM endpoint",
			ok: llm.ok,
			detail: llm.detail,
			fix: llm.ok ? null : "local LLM stack docs",
		},
		{
			id: "hubs",
			label: "Hub reachability",
			ok: hubs.ok,
			detail: hubs.detail,
			fix: hubs.ok ? null : "check the hub or its stack.yaml profile",
		},
		{ id: "bind", label: "LAN binding", ok: true, detail: BIND, fix: null },
	];
}

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
						w.state === "PAUSED",
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

export function events(): unknown[] {
	return (
		db
			.query(
				"SELECT id, ts, source, kind, scope, payload, target FROM events ORDER BY id DESC LIMIT 50",
			)
			.all() as EventRow[]
	).map((e) => {
		let note = "";
		try {
			note = e.payload
				? Object.entries(JSON.parse(e.payload))
						.map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
						.join(" ")
				: "";
		} catch {
			note = "(malformed)";
		}
		return {
			id: e.id,
			tsAgo: ago(e.ts),
			source: e.source,
			kind: e.kind,
			scope: e.scope,
			target: e.target,
			note,
		};
	});
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

// W685 batched read faces — one IN(...) statement per chunk replaces the
// per-row store RPCs that made a cold payload compute 684 curls ≈ 3.7s.
function factsByKeys(keys: string[]): Map<string, string> {
	const out = new Map<string, string>();
	chunked(keys, (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(`SELECT key, value FROM facts WHERE key IN (${ph})`)
			.all(...chunk) as { key: string; value: string }[])
			out.set(r.key, r.value);
	});
	return out;
}

function sessionsRoles(sids: string[]): Map<string, string> {
	const out = new Map<string, string>();
	chunked(sids.filter(Boolean), (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(`SELECT sid, role FROM sessions WHERE sid IN (${ph})`)
			.all(...chunk) as { sid: string; role: string | null }[])
			out.set(r.sid, r.role ?? "");
	});
	return out;
}

function eventPayloads(ids: number[]): Map<number, string | null> {
	const out = new Map<number, string | null>();
	chunked(ids, (chunk) => {
		const ph = chunk.map(() => "?").join(",");
		for (const r of db
			.query(`SELECT id, payload FROM events WHERE id IN (${ph})`)
			.all(...chunk) as { id: number; payload: string | null }[])
			out.set(r.id, r.payload);
	});
	return out;
}

// records per docs/decisions-api.md — legacy column names (event_id/target/
// answered_at/created_at) surface under their contract names at the API.
// OPEN decisions first, then newest resolved; advice (hooks/bin/advise.ts,
// fact advice.<id> or advice.<id>.error) rides along so the card can show
// the recommendation — the LLM advises, the human decides.
// W862: decisions forked from a hub-policy check carry their provenance
// (hub / row id / content pin) straight from the NEED_DECISION payload —
// the board card discloses origin, it never guesses from question text.
const policyProvenance = (
	raw: string | null,
): { hub: string; sha256: string; id: string; source: string } | null => {
	const policy = payloadOf(raw).policy;
	if (!policy || typeof policy !== "object") return null;
	const { hub, sha256, id, source } = policy as Record<string, unknown>;
	if (
		typeof hub !== "string" ||
		!hub ||
		typeof id !== "string" ||
		!id ||
		typeof sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(sha256)
	)
		return null;
	return {
		hub,
		sha256,
		id,
		source: typeof source === "string" ? source : "",
	};
};

export function decisionRecords(
	project: string | null = null,
): Record<string, unknown>[] {
	const selected = project && project !== "all" ? project : null;
	const rows = db
		.query(
			`SELECT d.*, w.title AS task_title FROM decisions d
			LEFT JOIN work_items w ON w.project = d.project AND w.id = d.task_id
			${selected ? "WHERE d.project = ?" : ""}
			ORDER BY (d.state = 'OPEN') DESC, d.event_id DESC LIMIT 200`,
		)
		.all(...(selected ? [selected] : [])) as {
		event_id: number;
		target: string;
		asked_by: string | null;
		project: string | null;
		task_id: string | null;
		question: string | null;
		options: string | null;
		state: string;
		delivery: string | null;
		answer_note: string | null;
		answer_to: string | null;
		answer_token: string | null;
		created_at: number;
		answered_at: number | null;
		ack_ts: number | null;
		task_title: string | null;
	}[];
	// W667: one batched liveness pass feeds every row — registry verdicts
	// (the `work lanes` surface) with the sessions face as fallback
	const verdicts = decisionVerdicts(
		rows.map((d) => ({ sid: d.target, project: d.project })),
	);
	// W685: the four per-row reads — advice fact, advice error, session role,
	// source-event payload — batch into four IN(...) reads (the profile's
	// 3.7s whale: 684 store RPCs per cold compute → ~7).
	const adviceRows = factsByKeys(
		rows.flatMap((d) => [`advice.${d.event_id}`, `advice.${d.event_id}.error`]),
	);
	const roles = sessionsRoles(rows.map((d) => d.target));
	const evPayloads = eventPayloads(rows.map((d) => d.event_id));
	const lm = labelMaps();
	return rows.map((d) => {
		let options: { label: string; tradeoff?: string | null }[] = [];
		try {
			options = d.options ? JSON.parse(d.options) : [];
		} catch {}
		let advice: unknown;
		let adviceError: string | undefined;
		const a = adviceRows.get(`advice.${d.event_id}`) ?? null;
		if (a) {
			try {
				const parsed = JSON.parse(a) as { rec?: unknown };
				if (usableRecommendation(parsed.rec)) advice = parsed;
				else adviceError = "stored recommendation is unusable — retry";
			} catch {}
		} else {
			const err = adviceRows.get(`advice.${d.event_id}.error`);
			if (err) adviceError = err.slice(0, 200);
		}
		const role = roles.get(d.target ?? "") ?? "worker";
		// W487 owner-actionable: a fork classified owner-needed, or one whose
		// target session is not RUNNING, must not dead-end on Send-to-lane —
		// the board renders it as an owner ruling and /api/answer resolves it
		// without a lane ack (same accept-set as routes-actions.ts).
		const classification = String(
			payloadOf(evPayloads.get(d.event_id) ?? null).classification ?? "",
		);
		const ownerNeeded =
			classification === "owner-needed" || classification === "owner_needed";
		const targetGone = d.target ? verdicts.get(d.target) === "dead" : true; // legacy no-target rows: gone by definition
		return {
			id: d.event_id,
			project: d.project || null,
			task_id: d.task_id,
			task_title: d.task_title ?? null,
			asked_by: d.asked_by || d.target,
			asked_by_label: labelFrom(lm, d.asked_by || d.target, role),
			target: d.target,
			question: d.question ?? "",
			options,
			state: d.state,
			delivery: d.delivery || "DELIVERED",
			answer_note: d.answer_note,
			answer_to: d.answer_to,
			answer_token: d.answer_token,
			owner_actionable: ownerNeeded || targetGone,
			owner_reason: ownerNeeded
				? "owner-needed"
				: targetGone
					? "target-dead"
					: null,
			created_ts: d.created_at,
			answered_ts: d.answered_at,
			ack_ts: d.ack_ts,
			age_s: ago(d.created_at),
			advice,
			adviceError,
			policy: policyProvenance(evPayloads.get(d.event_id) ?? null),
		};
	});
}

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

export function decisionsPayload(
	history: boolean,
	project: string | null = null,
): unknown {
	const selected = project && project !== "all" ? project : null;
	// W798: always-fresh — sync + records recompute per call; only /api/data
	// rides the memo (feedMemo).
	syncDecisions();
	const recs = collapseDups(decisionRecords(selected));
	const open = recs.filter((r) => r.state === "OPEN") as {
		project?: string | null;
	}[];
	// the default feed stays OPEN-only; &history=1 adds the resolved rows
	// (ANSWERED / ACKNOWLEDGED / CANCELLED) for the collapsed history view
	const shown = history ? recs : open;
	const byProject: Record<string, number> = {};
	for (const r of open)
		if (r.project) byProject[r.project] = (byProject[r.project] ?? 0) + 1;
	return { ts: Date.now(), count: open.length, byProject, decisions: shown };
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

// --demo: seed an idempotent demo partition — project <dbdir>/demo, not a
// real repo — so the board shows a living fleet from a cold start (README
// quickstart, product screenshot). Never writes into real projects; skips
