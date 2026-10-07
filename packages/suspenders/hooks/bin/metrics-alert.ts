// metrics-alert.ts — W452: scrape the fleet's EXISTING /status + /metrics
// surfaces (servicemon, W125) and alert on drops, failures and queue age.
// No new counter system — every signal is already exposed; this module only
// reads, diffs consecutive scrapes and shouts. Single-shot by default (exit
// 1 when alerts fired), --watch <s> loops it; NDJSON evidence appends to
// ~/.claude-insights/metrics-alerts.ndjson, diff state to
// ~/.claude-insights/metrics-alert-state.json (both atomic-write, bounded).
//
// Alert kinds:
//   DROP    scrape failed ≥ MISS_THRESHOLD consecutive passes
//   RECOVER target answering again after DROP
//   FAMILY  a metric family present last pass vanished
//   HEALTH  /status reports healthy=false
//   ERROR   /status last_error is fresh (< 5 min)
//   SPIKE   an alert-counter increased since the previous pass
//   QUEUE   oldest READY work item older than the queue-age threshold
//
// usage: bun metrics-alert.ts [--watch <s>] [--json]
//   targets: METRICS_ALERT_TARGETS env (comma-separated URLs), else the
//   loopback defaults (board :7799, buckle spoke :4101).
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { openGovernorDb } from "../lib/govdb.ts";
import { urlInQuietHours } from "../lib/stack-config.ts";

export interface Series {
	name: string;
	labels: Record<string, string>;
	value: number;
}

export interface StatusBody {
	service?: string;
	port?: number;
	healthy?: boolean;
	last_error?: { at?: string; message?: string } | null;
}

export type AlertKind =
	| "DROP"
	| "RECOVER"
	| "FAMILY"
	| "HEALTH"
	| "ERROR"
	| "SPIKE"
	| "QUEUE";

export interface Alert {
	kind: AlertKind;
	target: string;
	detail: string;
}

export const MISS_THRESHOLD = Number(process.env.METRICS_ALERT_MISS ?? 2);
export const QUEUE_AGE_MS =
	Number(process.env.METRICS_ALERT_QUEUE_HOURS ?? 24) * 3_600_000;
const SCRAPE_TIMEOUT_MS = 5_000;
const ERROR_FRESH_MS = 5 * 60_000;
// families whose increase means something broke (delta-diffed per pass)
export const ALERT_COUNTERS = [
	"buckle_ledger_dropped_total",
	"buckle_cooldown_ejections_total",
	"buckle_ladder_fallbacks_total",
	"buckle_flashx_refusals_total",
] as const;

const INSIGHTS = `${homedir()}/.claude-insights`;
export const STATE_PATH = `${INSIGHTS}/metrics-alert-state.json`;
export const NDJSON_PATH = `${INSIGHTS}/metrics-alerts.ndjson`;

// ---- Prometheus text exposition (read side only) --------------------------
export const labelKey = (labels: Record<string, string>): string =>
	Object.keys(labels)
		.sort()
		.map((k) => `${k}=${labels[k]}`)
		.join(",");

export function parseProm(text: string): Series[] {
	const out: Series[] = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const sp = t.lastIndexOf(" ");
		if (sp < 1) continue;
		const value = Number(t.slice(sp + 1));
		if (!Number.isFinite(value)) continue;
		const head = t.slice(0, sp);
		const open = head.indexOf("{");
		if (open < 0)
			out.push({ name: head, labels: {}, value });
		else
			out.push({
				name: head.slice(0, open),
				labels: parseLabels(head, open),
				value,
			});
	}
	return out;
}

const parseLabels = (head: string, open: number): Record<string, string> => {
	const labels: Record<string, string> = {};
	const body = head.slice(open + 1, head.lastIndexOf("}"));
	for (const pair of body.split(",")) {
		const eq = pair.indexOf("=");
		if (eq < 1) continue;
		labels[pair.slice(0, eq).trim()] = pair
			.slice(eq + 1)
			.trim()
			.replaceAll('"', "");
	}
	return labels;
};

// families present before and gone now — a counter system regressed
export function familyDrops(
	prev: Series[],
	cur: Series[],
): { name: string; labels: string }[] {
	const before = new Map(
		prev.map((s) => [`${s.name}|${labelKey(s.labels)}`, s] as const),
	);
	const after = new Set(cur.map((s) => `${s.name}|${labelKey(s.labels)}`));
	return [...before.keys()]
		.filter((k) => !after.has(k))
		.map((k) => {
			const s = before.get(k)!;
			return { name: s.name, labels: labelKey(s.labels) };
		});
}

// counter resets are legal (servicemon set()) — a reset never alerts
export function counterSpikes(
	prev: Series[],
	cur: Series[],
): { name: string; labels: string; delta: number }[] {
	const before = new Map(
		prev.map((s) => [`${s.name}|${labelKey(s.labels)}`, s] as const),
	);
	const out: { name: string; labels: string; delta: number }[] = [];
	for (const s of cur) {
		if (!(ALERT_COUNTERS as readonly string[]).includes(s.name)) continue;
		const was = before.get(`${s.name}|${labelKey(s.labels)}`);
		if (was && s.value - was.value > 0)
			out.push({
				name: s.name,
				labels: labelKey(s.labels),
				delta: s.value - was.value,
			});
	}
	return out;
}

// ---- status-side alerts (pure, exported for tests) ------------------------
export function statusAlerts(
	status: StatusBody,
	now: number,
): { kind: AlertKind; detail: string }[] {
	const out: { kind: AlertKind; detail: string }[] = [];
	if (status.healthy === false)
		out.push({ kind: "HEALTH", detail: "/status reports healthy=false" });
	const err = status.last_error;
	if (
		err?.at &&
		Number.isFinite(Date.parse(err.at)) &&
		now - Date.parse(err.at) < ERROR_FRESH_MS
	)
		out.push({
			kind: "ERROR",
			detail: `fresh last_error: ${err.message ?? "unknown"}`,
		});
	return out;
}

// the dispatch queue: READY work aging in the graph (read-only)
export function readyQueue(now: number): { count: number; oldestMs: number } {
	try {
		const db = openGovernorDb();
		const row = db
			.query(
				"SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM work_items WHERE state = 'READY'",
			)
			.get() as { n: number; oldest: number | null };
		return { count: row.n, oldestMs: row.oldest ? now - row.oldest : 0 };
	} catch {
		return { count: 0, oldestMs: 0 };
	}
}

// ---- diff state (bounded: per-target, pruned to live targets) -------------
interface TargetState {
	url: string;
	misses: number;
	lastOkAt: number | null;
	series: Series[];
	active: Record<string, string>;
}
export interface AlertState {
	targets: Record<string, TargetState>;
}

export function loadState(path = STATE_PATH): AlertState {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as AlertState;
	} catch {
		return { targets: {} };
	}
}

export function saveState(state: AlertState, path = STATE_PATH): void {
	mkdirSync(INSIGHTS, { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
	renameSync(tmp, path);
}

const targetState = (state: AlertState, url: string): TargetState =>
	(state.targets[url] ??= {
		url,
		misses: 0,
		lastOkAt: null,
		series: [],
		active: {},
	});

export const resolveTargets = (): string[] => {
	const raw = (process.env.METRICS_ALERT_TARGETS ?? "").trim();
	const list = raw
		? raw.split(",").map((s) => s.trim())
		: ["http://127.0.0.1:7799", "http://127.0.0.1:4101"];
	return list.filter((u) => /^https?:\/\//.test(u));
};

// one scrape pass against one target — mutates its TargetState
export async function scrapeTarget(
	state: AlertState,
	url: string,
	now: number,
	fetchFn: typeof fetch = fetch,
): Promise<Alert[]> {
	const st = targetState(state, url);
	const alerts: Alert[] = [];
	let cur: Series[] = [];
	let status: StatusBody | null = null;
	try {
		const opts = { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) };
		const [mRes, sRes] = await Promise.all([
			fetchFn(`${url}/metrics`, opts),
			fetchFn(`${url}/status`, opts),
		]);
		if (!mRes.ok || !sRes.ok)
			throw new Error(`HTTP ${mRes.status}/${sRes.status}`);
		cur = parseProm(await mRes.text());
		status = (await sRes.json()) as StatusBody;
	} catch (error) {
		st.misses += 1;
		const msg = error instanceof Error ? error.message : String(error);
		if (st.misses >= MISS_THRESHOLD && !st.active.DROP) {
			st.active.DROP = msg;
			alerts.push({
				kind: "DROP",
				target: url,
				detail: `${st.misses} failed scrapes (${msg})`,
			});
		}
		return alerts;
	}
	if (st.active.DROP) {
		delete st.active.DROP;
		alerts.push({ kind: "RECOVER", target: url, detail: "scrapes ok again" });
	}
	st.misses = 0;
	st.lastOkAt = now;
	alerts.push(...diffAlerts(st, cur, status, now));
	st.series = cur;
	return alerts;
}

// pure diff of a good scrape against the previous pass
export function diffAlerts(
	st: TargetState,
	cur: Series[],
	status: StatusBody | null,
	now: number,
): Alert[] {
	const alerts: Alert[] = [];
	if (st.series.length > 0)
		for (const f of familyDrops(st.series, cur))
			alerts.push({
				kind: "FAMILY",
				target: st.url,
				detail: `family dropped: ${f.name}{${f.labels}}`,
			});
	for (const s of counterSpikes(st.series, cur))
		alerts.push({
			kind: "SPIKE",
			target: st.url,
			detail: `${s.name}{${s.labels}} +${s.delta}`,
		});
	if (status)
		for (const a of statusAlerts(status, now))
			alerts.push({ kind: a.kind, target: st.url, detail: a.detail });
	return alerts;
}

// the queue-age pass: sticky QUEUE alert keyed on the __queue pseudo-target
export function queueAlerts(
	state: AlertState,
	q: { count: number; oldestMs: number },
): Alert[] {
	const alerts: Alert[] = [];
	const st = targetState(state, "__queue");
	if (q.oldestMs > QUEUE_AGE_MS && !st.active.QUEUE) {
		st.active.QUEUE = "oldest";
		alerts.push({
			kind: "QUEUE",
			target: "work-graph",
			detail: `oldest READY item ${Math.round(q.oldestMs / 60_000)}min old, ${q.count} READY`,
		});
	}
	if (q.oldestMs <= QUEUE_AGE_MS && st.active.QUEUE) {
		delete st.active.QUEUE;
		alerts.push({
			kind: "RECOVER",
			target: "work-graph",
			detail: "queue age back under threshold",
		});
	}
	return alerts;
}

export function queuePass(state: AlertState, now: number): Alert[] {
	return queueAlerts(state, readyQueue(now));
}

// ---- emit ------------------------------------------------------------------
export const formatAlert = (a: Alert): string =>
	`ALERT ${a.kind} ${a.target} — ${a.detail}`;

export function emitAlerts(alerts: Alert[]): void {
	if (!alerts.length) return;
	mkdirSync(INSIGHTS, { recursive: true, mode: 0o700 });
	const rows = alerts.map(
		(a) => JSON.stringify({ ts: new Date().toISOString(), ...a }),
	);
	appendFileSync(NDJSON_PATH, `${rows.join("\n")}\n`, { mode: 0o600 });
}

// ---- main (guarded: importable by tests) ----------------------------------
export const arg = (name: string): string | null => {
	const i = process.argv.indexOf(name);
	return i > 0 ? (process.argv[i + 1] ?? null) : null;
};

// W483: a quiet-hours hub is EXPECTED dark — skip the scrape (no DROP
// accumulates) and forgive misses so the 08:00 boot never pages a stale
// DROP; an active DROP from before the window survives and RECOVERs.
export function skipQuietTarget(
	s: AlertState,
	url: string,
	now: Date = new Date(),
): boolean {
	if (!urlInQuietHours(url, now)) return false;
	const st = s.targets[url];
	if (st) st.misses = 0;
	return true;
}

export async function runPass(s: AlertState): Promise<number> {
	const now = Date.now();
	const alerts: Alert[] = [];
	for (const t of resolveTargets()) {
		if (skipQuietTarget(s, t)) continue;
		alerts.push(...(await scrapeTarget(s, t, now)));
	}
	alerts.push(...queuePass(s, now));
	const out = arg("--json")
		? (a: Alert) => console.log(JSON.stringify(a))
		: (a: Alert) => console.log(formatAlert(a));
	for (const a of alerts) out(a);
	emitAlerts(alerts);
	saveState(s);
	return alerts.length;
}

if (import.meta.main) {
	const watchS = Number(arg("--watch") ?? 0);
	const s = loadState();
	let fired = 0;
	for (;;) {
		fired += await runPass(s);
		if (!watchS) break;
		await new Promise((r) => setTimeout(r, watchS * 1000));
	}
	if (fired > 0) process.exit(1);
}
