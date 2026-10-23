// metrics.ts — belt-collected endpoint metrics, merged from the two JSONL
// route logs belt already writes:
//   ~/.claude-insights/swarm-routing.log   (locals — router-shim/router-swarm)
//   ~/.claude/local-llm/remotes-routes.log (remotes — bin/remotes.ts route)
// A tally pass ingests only new bytes (per-log byte cursor, rotation-safe:
// shrink → wipe that source and re-read). routes is the source of truth;
// endpoint tallies are derived by SQL aggregate. metrics.db lives in the
// runtime dir (~/.claude/local-llm) — NEVER committed.
//
// CLI: bun metrics.ts [--json] — print the snapshot, then exit.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";

const HOME = process.env.HOME;
export const METRICS_DB = `${HOME}/.claude/local-llm/metrics.db`;
const SWARM_LOG = `${HOME}/.claude-insights/swarm-routing.log`;
const REMOTES_LOG = `${HOME}/.claude/local-llm/remotes-routes.log`;
export const LOCAL_NAME = hostname().replace(/\.local\.?$/, "");

export interface EndpointMetrics {
	calls: number;
	errors: number;
	/** Rows carrying a real duration sample (legacy failRoute rows write 0). */
	measured: number;
	avg_ms: number | null;
	last_used: string | null;
	/** Last ts among rows carrying a real duration sample — the latency
	 *  sample-freshness bound (W1030.2.1); a fresh duration-less failure
	 *  never rejuvenates the measured sample. */
	measured_last: string | null;
	/** Earliest ts in the measured sample window (null with no samples). */
	measured_first: string | null;
	load_5m: number;
	last_error?: string | null;
}

export interface MetricsSnapshot {
	endpoints: Record<string, EndpointMetrics>;
	recent: {
		ts: string;
		machine: string;
		port: number;
		model: string;
		role: string;
		duration_ms: number;
		ok: boolean;
	}[];
	audit: {
		ts: string;
		token_label: string;
		action: string;
		machine: string;
		port: number | null;
		model: string;
		decision: string;
		why: string;
	}[];
}

const KEEP_DAYS = 30;
const KEEP_ROWS = 20_000;

let db: Database | null = null;
function openDb(): Database {
	if (db) return db;
	db = new Database(METRICS_DB, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS routes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT NOT NULL,
			machine TEXT NOT NULL,
			port INTEGER NOT NULL,
			model TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT '',
			duration_ms INTEGER NOT NULL DEFAULT 0,
			ok INTEGER NOT NULL DEFAULT 1,
			err TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS routes_ts ON routes(ts);
		CREATE TABLE IF NOT EXISTS cursors (
			path TEXT PRIMARY KEY,
			pos INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS ingestion_versions (
			source TEXT PRIMARY KEY,
			version INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT NOT NULL,
			token_label TEXT NOT NULL DEFAULT '',
			action TEXT NOT NULL DEFAULT '',
			machine TEXT NOT NULL DEFAULT '',
			port INTEGER,
			model TEXT NOT NULL DEFAULT '',
			decision TEXT NOT NULL DEFAULT '',
			why TEXT NOT NULL DEFAULT '',
			belt_url TEXT NOT NULL DEFAULT '',
			gateway_url TEXT NOT NULL DEFAULT ''
		);
	`);
	// W96: hint column on pre-W96 databases — idempotent migration
	const cols = db.query("PRAGMA table_info(audit)").all() as {
		name: string;
	}[];
	if (!cols.some((c) => c.name === "hint"))
		db.run("ALTER TABLE audit ADD COLUMN hint TEXT NOT NULL DEFAULT ''");
	return db;
}

/** Audit trail — every /api/route decision (allowed AND denied) lands here;
 *  a product feature, not debugging residue. */
export function auditRoute(e: {
	ts: string;
	token_label: string;
	action: string;
	machine?: string;
	port?: number | null;
	model?: string;
	decision: string;
	why: string;
	hint?: string;
	belt_url: string;
	gateway_url: string;
}): void {
	openDb().run(
		"INSERT INTO audit (ts, token_label, action, machine, port, model, decision, why, hint, belt_url, gateway_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			e.ts,
			e.token_label,
			e.action,
			e.machine ?? "",
			e.port ?? null,
			e.model ?? "",
			e.decision,
			e.why,
			e.hint ?? "",
			e.belt_url,
			e.gateway_url,
		],
	);
}

// ─── ingestion ───

function ingestFile(
	path: string,
	source: string,
	map: (j: Record<string, unknown>) => {
		ts: string;
		machine: string;
		port: number;
		model: string;
		role: string;
		duration_ms: number;
		ok: boolean;
		err: string;
	} | null,
): void {
	const d = openDb();
	const cur = d.query("SELECT pos FROM cursors WHERE path = ?").get(path) as {
		pos: number;
	} | null;
	let pos = cur?.pos ?? 0;
	const size = existsSync(path) ? statSync(path).size : 0;
	if (size < pos) {
		// rotated/truncated — drop this source's rows and re-read everything
		d.run("DELETE FROM routes WHERE source = ?", [source]);
		pos = 0;
	}
	if (size === pos) return;
	const buf = readFileSync(path).subarray(pos);
	const text = `${buf.toString("utf8")}`;
	// last line may be partial — hand the offset back to just after the last \n
	const cut = text.lastIndexOf("\n");
	const whole = cut >= 0 ? text.slice(0, cut + 1) : "";
	for (const line of whole.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = map(JSON.parse(line) as Record<string, unknown>);
			if (row)
				d.run(
					"INSERT INTO routes (ts, machine, port, model, role, duration_ms, ok, err, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						row.ts,
						row.machine,
						row.port,
						row.model,
						row.role,
						row.duration_ms,
						row.ok ? 1 : 0,
						row.err,
						source,
					],
				);
		} catch {
			// malformed line — skip, never fail the tally pass
		}
	}
	const newPos = pos + Buffer.byteLength(whole, "utf8");
	if (size < newPos) return; // file shrank mid-read; retry next pass
	d.run(
		"INSERT INTO cursors (path, pos) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET pos = excluded.pos",
		[path, newPos],
	);
}

/** One tally pass: pull new lines from both route logs into the db, prune
 *  old/overflowing rows. Cheap when nothing new (two stat() calls). */
export function tallyMetrics(): void {
	// W1093: older ingesters counted every upstream_attempt as a completed
	// route. Rebuild only the swarm source once from its authoritative log;
	// preserve the remote source and its cursor.
	const d = openDb();
	d.transaction(() => {
		const version = d
			.query("SELECT version FROM ingestion_versions WHERE source = 'swarm'")
			.get() as { version: number } | null;
		if (version?.version === 2) return;
		d.run("DELETE FROM routes WHERE source = 'swarm'");
		d.run("DELETE FROM cursors WHERE path = ?", [SWARM_LOG]);
		d.run(
			"INSERT INTO ingestion_versions (source, version) VALUES ('swarm', 2) ON CONFLICT(source) DO UPDATE SET version = excluded.version",
		);
	})();
	// locals: port 0 = cloud escalation (keep, machine "cloud"); outcome set
	// only on failure ("empty"). Typed attempt events are not route outcomes.
	ingestFile(SWARM_LOG, "swarm", (j) => {
		if (j.event !== undefined && j.event !== "request_completed") return null;
		const ok =
			j.ok === true ||
			(j.ok !== false && (!j.outcome || j.outcome === "in_process"));
		return {
			ts: String(j.ts ?? ""),
			machine: j.port === 0 ? "cloud" : LOCAL_NAME,
			port: Number(j.port ?? 0),
			model: String(j.model ?? ""),
			role: String(j.category ?? ""),
			duration_ms: Number(j.duration_ms ?? 0),
			ok,
			err: ok ? "" : String(j.outcome ?? "error"),
		};
	});
	ingestFile(REMOTES_LOG, "remotes", (j) => {
		const port = Number(
			String(j.endpoint ?? "")
				.split(":")
				.pop(),
		);
		return {
			ts: String(j.ts ?? ""),
			machine: String(j.machine ?? ""),
			port: Number.isFinite(port) ? port : 0,
			// legacy lines carry no model — they key under machine:port with ''
			model: String(j.model ?? ""),
			role: String(j.role ?? ""),
			duration_ms: Number(j.duration_ms ?? 0),
			ok: j.ok !== false,
			err: j.ok === false ? "error" : "",
		};
	});
	const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
	d.run("DELETE FROM routes WHERE ts < ?", [cutoff]);
	d.run("DELETE FROM audit WHERE ts < ?", [cutoff]);
	d.run(
		"DELETE FROM routes WHERE id NOT IN (SELECT id FROM routes ORDER BY id DESC LIMIT ?)",
		[KEEP_ROWS],
	);
}

/** Weighted merge of several endpoints' metrics (port- or machine-level
 *  aggregates; avg_ms re-averaged by MEASURED sample count — zero-duration
 *  failure rows count in calls but carry no latency sample). */
function mergeMetrics(list: EndpointMetrics[]): EndpointMetrics {
	let calls = 0;
	let errors = 0;
	let load = 0;
	let totalMs = 0;
	let measured = 0;
	let lastUsed: string | null = null;
	let lastError: string | null = null;
	let measuredLast: string | null = null;
	let measuredFirst: string | null = null;
	for (const e of list) {
		calls += e.calls;
		errors += e.errors;
		load += e.load_5m;
		measured += e.measured;
		totalMs += (e.avg_ms ?? 0) * e.measured;
		if ((e.last_used ?? "") > (lastUsed ?? "")) lastUsed = e.last_used;
		if ((e.last_error ?? "") > (lastError ?? "")) lastError = e.last_error;
		if ((e.measured_last ?? "") > (measuredLast ?? ""))
			measuredLast = e.measured_last;
		// earliest measured sample across the fold (null when none carry samples)
		if (measuredFirst === null || (e.measured_first ?? "") < measuredFirst)
			measuredFirst = e.measured_first ?? measuredFirst;
	}
	return {
		calls,
		errors,
		measured,
		load_5m: load,
		avg_ms: measured ? Math.round(totalMs / measured) : null,
		last_used: lastUsed,
		measured_last: measuredLast,
		measured_first: measuredFirst,
		last_error: lastError,
	};
}

// ─── snapshot ───

const agg = `
	SELECT machine, port, model,
	       COUNT(*) AS calls,
	       SUM(ok = 0) AS errors,
	       SUM(duration_ms > 0) AS measured,
	       AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS avg_ms,
	       MAX(ts) AS last_used,
	       MAX(CASE WHEN duration_ms > 0 THEN ts END) AS measured_last,
	       MIN(CASE WHEN duration_ms > 0 THEN ts END) AS measured_first
	FROM routes GROUP BY machine, port, model`;

const loadQ = `
	SELECT machine, port, model, COUNT(*) AS n
	FROM routes WHERE ts > ? GROUP BY machine, port, model`;

const lastErrQ = `
	SELECT machine, port, model, err, MAX(ts) AS ets
	FROM routes WHERE ok = 0 GROUP BY machine, port, model`;

const recentQ = `
	SELECT ts, machine, port, model, role, duration_ms, ok
	FROM routes ORDER BY id DESC LIMIT 12`;

const auditQ = `
	SELECT ts, token_label, action, machine, port, model, decision, why, hint
	FROM audit ORDER BY id DESC LIMIT 12`;

function buildSnapshot(): MetricsSnapshot {
	const d = openDb();
	const endpoints: Record<string, EndpointMetrics> = {};
	const key = (m: string, p: number, mod: string): string => `${m}:${p}:${mod}`;
	for (const r of d.query(agg).all() as {
		machine: string;
		port: number;
		model: string;
		calls: number;
		errors: number;
		measured: number;
		avg_ms: number | null;
		last_used: string;
		measured_last: string | null;
		measured_first: string | null;
	}[]) {
		endpoints[key(r.machine, r.port, r.model)] = {
			calls: r.calls,
			errors: r.errors,
			measured: r.measured,
			avg_ms: r.avg_ms === null ? null : Math.round(r.avg_ms),
			last_used: r.last_used,
			measured_last: r.measured_last,
			measured_first: r.measured_first,
			load_5m: 0,
			last_error: null,
		};
	}
	const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
	for (const r of d.query(loadQ).all(fiveMinAgo) as {
		machine: string;
		port: number;
		model: string;
		n: number;
	}[]) {
		const e = endpoints[key(r.machine, r.port, r.model)];
		if (e) e.load_5m = r.n;
	}
	for (const r of d.query(lastErrQ).all() as {
		machine: string;
		port: number;
		model: string;
		err: string;
	}[]) {
		const e = endpoints[key(r.machine, r.port, r.model)];
		if (e) e.last_error = r.err || "error";
	}
	const recent = (
		d.query(recentQ).all() as {
			ts: string;
			machine: string;
			port: number;
			model: string;
			role: string;
			duration_ms: number;
			ok: number;
		}[]
	).map((r) => ({ ...r, ok: !!r.ok }));
	const audit = d.query(auditQ).all() as {
		ts: string;
		token_label: string;
		action: string;
		machine: string;
		port: number | null;
		model: string;
		decision: string;
		why: string;
		hint?: string;
	}[];
	return { endpoints, recent, audit };
}

// ─── history — time-bucketed trend series for the dashboard charts ───

export interface MetricsHistory {
	windowMs: number;
	bucketMs: number;
	/** [bucket-start unix s, requests, errors, avg duration ms | null,
	 *  measured samples] per bucket — avg spans MEASURED rows only; legacy
	 *  zero-duration failure rows count in requests/errors, never in ms. */
	buckets: [number, number, number, number | null, number][];
	/** Per-endpoint request counts and observed models on the SAME grid as `buckets`. */
	endpoints: { key: string; counts: number[]; models: string[] }[];
}

const HISTORY_WINDOW_MS = 6 * 3_600_000;
const HISTORY_BUCKETS = 72;

export function metricsHistory(): MetricsHistory {
	tallyMetrics();
	const d = openDb();
	const step = HISTORY_WINDOW_MS / HISTORY_BUCKETS / 1000; // seconds
	const now = Date.now();
	const end = Math.floor(now / (step * 1000)) * step;
	const start = end - (HISTORY_BUCKETS - 1) * step;
	const since = new Date(start * 1000).toISOString();
	const grid = (sel: string, group: string): string =>
		`SELECT ${sel} CAST(strftime('%s', ts) AS INTEGER)/${step}*${step} AS b, COUNT(*) AS n FROM routes WHERE ts >= ? GROUP BY ${group}`;
	const rows = d
		.query(
			grid(
				`SUM(ok = 0) AS err, SUM(duration_ms > 0) AS m, AVG(CASE WHEN duration_ms > 0 THEN duration_ms END) AS ms,`,
				"b",
			),
		)
		.all(since) as {
		b: number;
		n: number;
		err: number;
		m: number;
		ms: number | null;
	}[];
	const byGrid = new Map(rows.map((r) => [r.b, r]));
	const buckets: [number, number, number, number | null, number][] = [];
	for (let i = 0; i < HISTORY_BUCKETS; i++) {
		const t = start + i * step;
		const r = byGrid.get(t);
		buckets.push(
			r
				? [t, r.n, r.err, r.ms === null ? null : Math.round(r.ms), r.m]
				: [t, 0, 0, null, 0],
		);
	}
	const epRows = d
		.query(grid("machine, port, model,", "machine, port, model, b"))
		.all(since) as {
		machine: string;
		port: number;
		model: string;
		b: number;
		n: number;
	}[];
	const epMap = new Map<
		string,
		{ counts: Map<number, number>; models: Set<string> }
	>();
	for (const r of epRows) {
		const k = `${r.machine}:${r.port}`;
		const g = epMap.get(k) ?? {
			counts: new Map<number, number>(),
			models: new Set<string>(),
		};
		g.counts.set(r.b, (g.counts.get(r.b) ?? 0) + r.n);
		if (r.model) g.models.add(r.model);
		epMap.set(k, g);
	}
	const endpoints = [...epMap.entries()]
		.map(([key, g]) => ({
			key,
			counts: buckets.map((b) => g.counts.get(b[0]) ?? 0),
			models: [...g.models].sort(),
		}))
		.sort((a, z) => a.key.localeCompare(z.key));
	return {
		windowMs: HISTORY_WINDOW_MS,
		bucketMs: step * 1000,
		buckets,
		endpoints,
	};
}

let cache: { snap: MetricsSnapshot; at: number } | null = null;
const TTL_MS = 5_000;

/** Cached metrics snapshot — one tally pass + aggregate per 5 s max. */
export function metricsSnapshot(): MetricsSnapshot {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.snap;
	tallyMetrics();
	cache = { snap: buildSnapshot(), at: Date.now() };
	return cache.snap;
}

const EMPTY: EndpointMetrics = {
	calls: 0,
	errors: 0,
	measured: 0,
	avg_ms: null,
	last_used: null,
	measured_last: null,
	measured_first: null,
	load_5m: 0,
	last_error: null,
};

/** Fold metrics for one row: exact (machine, port, model) first, then any
 *  model on that machine:port, then the whole machine (port omitted). */
export function metricsFor(
	machine: string,
	port?: number,
	model?: string | null,
): EndpointMetrics {
	const { endpoints } = metricsSnapshot();
	if (model) {
		const exact = endpoints[`${machine}:${port}:${model}`];
		if (exact) return exact;
	}
	if (port != null) {
		const anyModel = Object.entries(endpoints)
			.filter(([k]) => k.startsWith(`${machine}:${port}:`))
			.map(([, e]) => e);
		if (anyModel.length) return mergeMetrics(anyModel);
	}
	if (port == null) {
		const all = Object.entries(endpoints)
			.filter(([k]) => k.startsWith(`${machine}:`))
			.map(([, e]) => e);
		if (all.length) return mergeMetrics(all);
	}
	return EMPTY;
}

if (import.meta.main) {
	const snap = metricsSnapshot();
	if (process.argv.includes("--json")) console.log(JSON.stringify(snap));
	else
		console.table(
			Object.entries(snap.endpoints).map(([k, e]) => ({ endpoint: k, ...e })),
		);
}
