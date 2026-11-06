// W2787 — lane drift detection: behavioral quality per lane-class over a
// rolling window, read-only (detection + alert; enforcement later). Rides
// events already on the bus — no new telemetry:
//   work.review       verdict PASS/FAIL + receipt.blocking[] count
//   work.done         verified=false rate
//   work.retried      retry count
//   NEED_DECISION     completion-block refusals (payload.code)
// Lane class = the item's top model_group from its latest work.attribution
// backfill; items without attribution fold into "unattributed".
// A class drifts when its current window's metric shifts beyond threshold
// against the previous window, with >= minSamples on BOTH sides.
import type { Database } from "bun:sqlite";
import type { GovernorStore } from "../govdb/govdb-store.ts";

export interface DriftEventRow {
	id: number;
	ts: number;
	kind: string;
	payload: string | null;
}

export interface DriftOptions {
	now: number;
	windowMs: number;
	minSamples: number;
	/** percentage points a rate may move before it alerts */
	thresholdPts: number;
}

export const DRIFT_DEFAULTS: Omit<DriftOptions, "now"> = {
	windowMs: 7 * 86_400_000,
	minSamples: 5,
	thresholdPts: 15,
};

export interface WindowStats {
	reviews: number;
	pass: number;
	blocking: number;
	done: number;
	unverified: number;
	retries: number;
	refusals: Record<string, number>;
}

export interface ClassDrift {
	lane_class: string;
	current: WindowStats;
	previous: WindowStats;
	/** PASS rate in percent, null when the window has no reviews */
	pass_rate: { current: number | null; previous: number | null };
	alerts: DriftAlert[];
}

export type DriftMetric =
	| "review_pass_rate"
	| "done_unverified_rate"
	| "blocking_per_review";

export interface DriftAlert {
	lane_class: string;
	metric: DriftMetric;
	previous: number;
	current: number;
	delta: number;
	samples: { previous: number; current: number };
}

const DRIFT_KINDS =
	"('work.review','work.done','work.retried','NEED_DECISION','work.attribution')";

/** The bus rows the detector replays — two windows back from now. */
export function readDriftRows(
	db: Database | GovernorStore,
	project: string,
	since: number,
): DriftEventRow[] {
	return db
		.query(
			`SELECT id, ts, kind, payload FROM events WHERE kind IN ${DRIFT_KINDS} AND (ts >= ? OR kind = 'work.attribution') AND json_valid(payload) AND json_extract(payload, '$.project') = ? ORDER BY ts, id`,
		)
		.all(since, project) as DriftEventRow[];
}

const emptyStats = (): WindowStats => ({
	reviews: 0,
	pass: 0,
	blocking: 0,
	done: 0,
	unverified: 0,
	retries: 0,
	refusals: {},
});

const parse = (raw: string | null): Record<string, unknown> => {
	try {
		const v = JSON.parse(raw ?? "{}") as unknown;
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

/** Top model_group by attributed tokens from a work.attribution backfill. */
export function topGroup(backfill: unknown): string | null {
	if (typeof backfill !== "string") return null;
	const groups = parse(backfill).groups;
	if (!groups || typeof groups !== "object") return null;
	let best: [string, number] | null = null;
	for (const [g, s] of Object.entries(groups as Record<string, unknown>)) {
		const spend = (s ?? {}) as Record<string, unknown>;
		const t = ["in", "out", "cacheR", "cacheC"].reduce(
			(n, k) => n + (Number(spend[k]) || 0),
			0,
		);
		if (t > 0 && (!best || t > best[1] || (t === best[1] && g < best[0])))
			best = [g, t];
	}
	return best?.[0] ?? null;
}

const blockingCount = (receipt: unknown): number => {
	const b = parse(typeof receipt === "string" ? receipt : null).blocking;
	return Array.isArray(b) ? b.length : 0;
};

function tally(stats: WindowStats, kind: string, p: Record<string, unknown>) {
	if (kind === "work.review") {
		if (p.verdict !== "PASS" && p.verdict !== "FAIL") return;
		stats.reviews++;
		if (p.verdict === "PASS") stats.pass++;
		stats.blocking += blockingCount(p.receipt);
	} else if (kind === "work.done") {
		stats.done++;
		if (p.verified === false) stats.unverified++;
	} else if (kind === "work.retried") stats.retries++;
	else if (kind === "NEED_DECISION" && typeof p.code === "string")
		stats.refusals[p.code] = (stats.refusals[p.code] ?? 0) + 1;
}

const pct = (n: number, d: number): number | null =>
	d > 0 ? Math.round((n / d) * 1000) / 10 : null;

function alertsFor(c: ClassDrift, o: DriftOptions): DriftAlert[] {
	const out: DriftAlert[] = [];
	const check = (
		metric: DriftMetric,
		prev: number | null,
		cur: number | null,
		n: { previous: number; current: number },
		worse: (delta: number) => boolean,
		limit: number,
	) => {
		if (prev === null || cur === null) return;
		if (n.previous < o.minSamples || n.current < o.minSamples) return;
		const delta = Math.round((cur - prev) * 10) / 10;
		if (worse(delta) && Math.abs(delta) > limit)
			out.push({
				lane_class: c.lane_class,
				metric,
				previous: prev,
				current: cur,
				delta,
				samples: n,
			});
	};
	const r = { previous: c.previous.reviews, current: c.current.reviews };
	check(
		"review_pass_rate",
		c.pass_rate.previous,
		c.pass_rate.current,
		r,
		(d) => d < 0,
		o.thresholdPts,
	);
	check(
		"done_unverified_rate",
		pct(c.previous.unverified, c.previous.done),
		pct(c.current.unverified, c.current.done),
		{ previous: c.previous.done, current: c.current.done },
		(d) => d > 0,
		o.thresholdPts,
	);
	const per = (s: WindowStats) =>
		s.reviews > 0 ? Math.round((s.blocking / s.reviews) * 10) / 10 : null;
	// blocking findings per review: a +1.0 shift is the alert line
	check(
		"blocking_per_review",
		per(c.previous),
		per(c.current),
		r,
		(d) => d > 0,
		1,
	);
	return out;
}

/** Pure: replay rows into per-class current/previous windows + alerts. */
export function computeDrift(
	rows: DriftEventRow[],
	o: DriftOptions,
): ClassDrift[] {
	const classOf = new Map<string, string>();
	for (const r of rows) {
		if (r.kind !== "work.attribution") continue;
		const p = parse(r.payload);
		const g = topGroup(p.backfill);
		if (typeof p.work === "string" && g) classOf.set(p.work, g);
	}
	const curStart = o.now - o.windowMs;
	const prevStart = curStart - o.windowMs;
	const classes = new Map<string, ClassDrift>();
	for (const r of rows) {
		if (r.kind === "work.attribution" || r.ts < prevStart || r.ts > o.now)
			continue;
		const p = parse(r.payload);
		const work = typeof p.work === "string" ? p.work : "";
		const lane = classOf.get(work) ?? "unattributed";
		let c = classes.get(lane);
		if (!c) {
			c = {
				lane_class: lane,
				current: emptyStats(),
				previous: emptyStats(),
				pass_rate: { current: null, previous: null },
				alerts: [],
			};
			classes.set(lane, c);
		}
		tally(r.ts >= curStart ? c.current : c.previous, r.kind, p);
	}
	const out = [...classes.values()].sort((a, b) =>
		a.lane_class < b.lane_class ? -1 : 1,
	);
	for (const c of out) {
		c.pass_rate = {
			current: pct(c.current.pass, c.current.reviews),
			previous: pct(c.previous.pass, c.previous.reviews),
		};
		c.alerts = alertsFor(c, o);
	}
	return out;
}

/** Emit one `lane.drift` event per alert, idempotent per class+metric+window
 *  (window index = floor(now / windowMs)) so a sweep re-run never re-alerts. */
export function emitDriftAlerts(
	db: GovernorStore,
	project: string,
	alerts: DriftAlert[],
	o: DriftOptions,
	emit: (kind: string, scope: string, extra: Record<string, string>) => number,
): number[] {
	const windowIndex = String(Math.floor(o.now / o.windowMs));
	const ids: number[] = [];
	for (const a of alerts) {
		const key = `${a.lane_class}|${a.metric}|${windowIndex}`;
		const seen = db
			.query(
				"SELECT id FROM events WHERE kind = 'lane.drift' AND json_valid(payload) AND json_extract(payload, '$.project') = ? AND json_extract(payload, '$.drift_key') = ? LIMIT 1",
			)
			.get(project, key);
		if (seen) continue;
		ids.push(
			emit("lane.drift", a.lane_class, {
				drift_key: key,
				lane_class: a.lane_class,
				metric: a.metric,
				previous: String(a.previous),
				current: String(a.current),
				delta: String(a.delta),
				samples: JSON.stringify(a.samples),
			}),
		);
	}
	return ids;
}

/** One-line human render per class (pulse/board text face). */
export function driftLine(c: ClassDrift): string {
	const rate = (v: number | null) => (v === null ? "—" : `${v}%`);
	const flag = c.alerts.length
		? ` ⚠ ${c.alerts.map((a) => `${a.metric} ${a.delta > 0 ? "+" : ""}${a.delta}`).join(", ")}`
		: "";
	return `${c.lane_class}: pass ${rate(c.pass_rate.previous)} → ${rate(c.pass_rate.current)} (n ${c.previous.reviews}/${c.current.reviews}) · done ${c.current.done} unverified ${c.current.unverified} · retries ${c.current.retries}${flag}`;
}
