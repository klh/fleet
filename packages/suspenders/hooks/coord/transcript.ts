// hooks/coord/transcript.ts — W2956: the per-lane transcript query face.
// Lane transcripts were not queryable, so duplicated LLM work after a stall
// was invisible after the fact (the OpenHands taxonomy finding behind this
// item). One verb over the coord verb surface: a lane's trail (sid positional),
// one item's cross-lane trail with per-lane claim windows + windowed ledger
// spend + dual-work overlap findings (--item), or a recent-lanes overview
// (bare). Rides the W603 shred columns (events.work/project + indexes) —
// item reads are indexed, never a per-row payload scan.
import type { Database } from "bun:sqlite";
import { ageOf } from "./bus.ts";
import {
	cyan,
	db,
	die,
	dim,
	green,
	type Ev,
	projectIdentity,
	red,
} from "./shared.ts";
import {
	ATTRIBUTION_LOOKBACK_MS,
	laneSpendRows,
	resolveBuckleDb,
} from "../lib/lanes/lane-spend.ts";
import { claimWindows, type ClaimWindow } from "../lib/work/work-timing.ts";
import {
	type LaneSegment,
	laneSegments,
	type OverlapPair,
	overlapPairs,
} from "../lib/work/work-transcript.ts";

// Trail row: the Ev shape plus the bus's target column.
interface TrailRow extends Ev {
	target: string | null;
}

const parsePayload = (s: string | null): Record<string, unknown> => {
	try {
		return JSON.parse(s ?? "{}") as Record<string, unknown>;
	} catch {
		return {};
	}
};

// One trail line. kind + acting sid + the payload keys that make an audit
// read work (by/sha/verdict/answer/note/...); sha + note render like
// formatEventLine (the ONE bus row-renderer) so the faces never drift.
const trailLine = (r: TrailRow, showSource: boolean): string => {
	const p = parsePayload(r.payload);
	const { sha, note, work, project, ...restP } = p as Record<string, string>;
	const extra = Object.entries(restP)
		.map(([k, v]) => `${dim(`${k}=`)}${String(v)}`)
		.join(" ");
	const who = showSource
		? ` ${r.source === "_" ? "fleet" : r.source.slice(0, 12)}`
		: "";
	return `  ${dim(`#${r.id}`)} ${dim(ageOf(r.ts).padStart(4))} ${cyan(r.kind)}${r.target ? ` →${r.target.slice(0, 12)}` : ""}${sha ? green(`@${String(sha).slice(0, 8)}`) : ""} ${who}${Object.keys(restP).length ? `  ${extra}` : ""}${note ? dim(` — ${String(note).slice(0, 160)}`) : ""}`;
};

// --since vocabulary: a bare number is an epoch-ms floor, else a duration
// like 45s / 30m / 6h / 7d. Unparseable input dies with the usage hint.
const sinceMs = (raw: string): number => {
	if (/^\d+$/.test(raw)) return Number(raw);
	const m = raw.match(/^(\d+)([smhd])$/);
	if (!m) die("--since takes <epoch-ms> | <N>s|m|h|d");
	const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
		m[2] as "s" | "m" | "h" | "d"
	];
	return Date.now() - Number(m[1]) * mult;
};

// The trail query, on shred columns + the events_work_id index. Only the
// where/params change between modes; --since bounds ts, --last caps rows.
function trailRows(o: {
	where: string;
	params: (string | number)[];
	since: number | null;
	last: number;
}): TrailRow[] {
	const sinceClause = o.since !== null ? ` AND ts >= ${o.since}` : "";
	return db
		.query(
			`SELECT id, ts, source, kind, scope, payload, target FROM events WHERE ${o.where}${sinceClause} ORDER BY id DESC LIMIT ?`,
		)
		.all(...o.params, o.last) as TrailRow[];
}

// Spend resolution, fail-soft (metrics never blocks on the gateway — the
// W635 honesty rule): an unreadable/absent ledger returns null and the
// render marks spend cells unknown instead of zero.
const ledgerRows = (): ReturnType<typeof laneSpendRows> | null => {
	const path = resolveBuckleDb();
	if (!path) return null;
	try {
		const cut = new Date(Date.now() - ATTRIBUTION_LOOKBACK_MS)
			.toISOString()
			.slice(0, 13);
		return laneSpendRows(path, `${cut}:00`);
	} catch {
		return null;
	}
};

// HH:MM UTC — the audit table's window label grain.
const hm = (t: number): string => {
	const d = new Date(t);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// The audit table's window label — span, or the multi-window count.
const spanOf = (s: LaneSegment): string => {
	const w0 = s.windows[0];
	if (!w0) return "no claim window";
	return s.windows.length === 1
		? `${hm(w0.start)}–${hm(w0.end)}`
		: `${s.windows.length} windows`;
};

const compact = (n: number): string => {
	const units = ["", "k", "M", "G"];
	let i = 0;
	let v = n;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${i === 0 ? String(v) : v.toFixed(1)}${units[i]}`;
};

// The per-lane audit table: windows, event counts, windowed ledger spend.
function auditTable(
	segs: Map<string, LaneSegment>,
	counts: Map<string, number>,
): void {
	for (const [sid, s] of segs) {
		const c = counts.get(sid) ?? 0;
		const spend = s.reported
			? `${compact(s.fresh)}+${compact(s.cached)}c/${compact(s.out)}o`
			: "—";
		const cost = s.costUsd === null ? "" : `  $${s.costUsd.toFixed(4)}`;
		console.log(
			`  ${sid.slice(0, 24).padEnd(24)} ${spanOf(s).padEnd(18)} ev=${String(c).padEnd(6)} spend=${spend}${cost}`,
		);
	}
}

const overlapLine = (o: OverlapPair): string =>
	`  OVERLAP ${o.a.sid.slice(0, 16)} × ${o.b.sid.slice(0, 16)} ${hm(o.start)}–${hm(o.end)} (${Math.round((o.end - o.start) / 60_000)}m)`;

const jsonEvent = (r: TrailRow): Record<string, unknown> => ({
	id: r.id,
	ts: r.ts,
	source: r.source,
	kind: r.kind,
	scope: r.scope,
	target: r.target,
	payload: parsePayload(r.payload),
});

// The trail face. Positional sid → lane mode; --item → item mode; bare → the
// recent-lanes overview. Both audit modes share the trail query; item mode
// adds the W635 per-lane spend join + dual-work overlap findings.
export function cmdTranscript(p: {
	pos: string[];
	flag: (n: string) => string | null;
	rest: string[];
}): void {
	const item = p.flag("--item");
	const sid = p.pos[0];
	const last = Number(p.flag("--last") ?? 100);
	if (!Number.isInteger(last) || last < 1)
		die("--last must be a positive integer");
	const sinceRaw = p.flag("--since");
	const since = sinceRaw ? sinceMs(sinceRaw) : null;
	const wantJson = p.rest.includes("--json");
	const kinds = p.flag("--kinds")?.split(",").filter(Boolean) ?? [];
	const kindClause = kinds.length
		? ` AND kind IN (${kinds.map(() => "?").join(",")})`
		: "";
	const project = projectIdentity();

	if (sid) {
		// lane mode: the lane's own trail, oldest-first. Actor = payload.by
		// (work-graph CLI events carry source="work", the actor in $.by) or
		// the bus source column (coord-verb events), targeted rows included.
		const rows = trailRows({
			where: `(source = ? OR target = ? OR json_extract(payload, '$.by') = ?)${item ? " AND work = ?" : ""}${kindClause}`,
			params: item
				? [sid, sid, sid, item, ...kinds]
				: [sid, sid, sid, ...kinds],
			since,
			last,
		}).reverse();
		if (wantJson) {
			console.log(
				JSON.stringify({
					mode: "sid",
					sid,
					item: item ?? null,
					shown: rows.length,
					events: rows.map(jsonEvent),
				}),
			);
			return;
		}
		console.log(
			`transcript ${sid}${item ? ` — item ${item}` : ""} — ${rows.length} shown`,
		);
		for (const r of rows) console.log(trailLine(r, false));
		return;
	}

	if (item) {
		// item mode: cross-lane trail + the per-lane audit + dual-work overlaps
		const rows = trailRows({
			where: `work = ? AND project = ?${kindClause}`,
			params: [item, project, ...kinds],
			since,
			last,
		}).reverse();
		const total = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM events WHERE work = ? AND project = ?",
				)
				.get(item, project) as { n: number }
		).n;
		const counts = new Map<string, number>(
			(
				db
					.query(
						`SELECT COALESCE(json_extract(payload, '$.by'), source) AS actor, COUNT(*) AS n FROM events WHERE work = ? AND project = ? GROUP BY actor`,
					)
					.all(item, project) as { actor: string; n: number }[]
			).map((r) => [r.actor, r.n]),
		);
		const wins: ClaimWindow[] =
			claimWindows(db as Database, project).windows.get(item) ?? [];
		const segs = laneSegments(wins, ledgerRows());
		const overlaps = overlapPairs(item, wins);
		if (wantJson) {
			console.log(
				JSON.stringify({
					mode: "item",
					item,
					project,
					shown: rows.length,
					total,
					events: rows.map(jsonEvent),
					lanes: [...segs.values()],
					overlaps,
				}),
			);
			return;
		}
		console.log(`transcript ${item} — per-lane audit (project ${project})`);
		auditTable(segs, counts);
		for (const o of overlaps) console.log(red(overlapLine(o)));
		if (!overlaps.length) console.log(dim("  no dual-work overlaps"));
		console.log(
			dim(`trail — ${rows.length} of ${total} events, oldest first:`),
		);
		for (const r of rows) console.log(trailLine(r, true));
		return;
	}
	renderOverview(last, since, wantJson);
}

// Human label for the overview window.
const sinceOf = (since: number | null): string => {
	if (since === null) return "all time";
	const mins = Math.max(1, Math.round((Date.now() - since) / 60_000));
	return mins < 60
		? `${mins}m`
		: mins < 1440
			? `${Math.round(mins / 60)}h`
			: `${Math.round(mins / 1440)}d`;
};

// Bare face: which lanes are on the bus, how loud, on what items — the
// entry point for a duplicate-spend sweep (drill into one lane or one item).
function renderOverview(
	last: number,
	since: number | null,
	wantJson: boolean,
): void {
	const floor = since ?? 0;
	const rows = db
		.query(
			"SELECT source, COUNT(*) AS n, COUNT(DISTINCT work) AS items, MIN(ts) AS first, MAX(ts) AS last FROM events WHERE source IS NOT NULL AND source != '' AND ts >= ? GROUP BY source ORDER BY last DESC LIMIT ?",
		)
		.all(floor, last) as {
		source: string;
		n: number;
		items: number;
		first: number;
		last: number;
	}[];
	if (wantJson) {
		console.log(
			JSON.stringify({ mode: "overview", since: floor, lanes: rows }),
		);
		return;
	}
	console.log(`transcript overview — lanes on the bus, last ${sinceOf(since)}`);
	for (const r of rows)
		console.log(
			`  ${r.source.slice(0, 24).padEnd(24)} ev=${String(r.n).padEnd(6)} items=${String(r.items).padEnd(4)} last ${ageOf(r.last)}`,
		);
	console.log(
		dim(
			`${rows.length} lane${rows.length === 1 ? "" : "s"} — drill in: transcript <sid> | transcript --item <id>`,
		),
	);
}
