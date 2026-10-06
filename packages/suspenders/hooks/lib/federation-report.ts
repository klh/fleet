// hooks/lib/federation-report.ts — W171 federation phase 3 spoke side: the
// opt-in aggregate self-report. Reads the pulled manifest's
// federation.self_report rule (per-team opt-in; default OFF = absent rule,
// the reporter never POSTs), aggregates the LOCAL usage_rollup by
// model-class (routing-doctrine classes — actor and model names are
// dropped in the GROUP BY, never serialized) and aid_rollup (private-domain
// rows filtered out — domain separation), and POSTs hourly windows to the
// hub. No names/content: the wire payload allows no identity fields.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
	loadLastKnown,
	type FederationEnv,
	federationHome,
} from "./federation.ts";
import { atomicWrite } from "./board-config.ts";

// Mirror of buckle MODEL_CLASSES (the cross-package contract; assert-equal
// with GROUPS in the spoke test suite).
export const REPORT_CLASSES = [
	"flash",
	"full",
	"luna",
	"local",
	"other",
] as const;

export type ReportClass = (typeof REPORT_CLASSES)[number];

/** The manifest's self-report rule, or null when the hub has NOT opted any
 *  teams in (default OFF). */
export function selfReportRule(
	manifest: { rules: Array<Record<string, unknown>> } | null,
): { teams: string[] } | null {
	if (manifest === null) return null;
	for (const r of manifest.rules) {
		if (r.id !== "federation.self_report") continue;
		const data = r.data as { teams?: unknown } | undefined;
		const teams = Array.isArray(data?.teams) ? data?.teams : [];
		return {
			teams: teams.filter(
				(t): t is string => typeof t === "string" && t.length > 0,
			),
		};
	}
	return null;
}

/** Cursor store path: <home>/federation-report-cursor.json. */
export function reportCursorPath(env: FederationEnv = {}): string {
	return join(federationHome(env), "federation-report-cursor.json");
}

export interface ReportCursor {
	last_bucket: number;
	reported_at: string;
}

export function loadCursor(env: FederationEnv = {}): ReportCursor | null {
	const p = reportCursorPath(env);
	if (!existsSync(p)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const r = parsed as ReportCursor;
		return typeof r.last_bucket === "number" ? r : null;
	} catch {
		return null;
	}
}

export interface ReportClassRow {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

export interface ReportAidRow {
	aid: string;
	domain: string;
	injected: number;
	skipped: number;
	tok_injected: number;
}

export interface ReportWindow {
	bucket: number;
	classes: Partial<Record<ReportClass, ReportClassRow>>;
	aids: ReportAidRow[];
}

export interface ReportPayload {
	team: string;
	windows: ReportWindow[];
}

/** Aggregate the spoke-local ledgers into the wire payload. Reads ONLY the
 *  two rollup tables; actor and model columns are never selected — names
 *  are dropped at the SQL layer, not filtered after. Private-domain aid
 *  rows are excluded (domain separation). Windows with neither classes nor
 *  aids are omitted honestly. */
export function buildSelfReport(
	db: Database,
	opts: {
		team: string;
		sinceBucket: number;
		untilBucket?: number;
		nowMs?: number;
	},
): ReportPayload {
	const now = opts.nowMs ?? Date.now();
	const until = opts.untilBucket ?? Math.floor(now / 3_600_000) * 3_600_000;
	const buckets = new Map<number, ReportWindow>();
	const classes = (
		db
			.query(
				`SELECT hour_bucket AS b, model_group AS g,
				SUM(in_tok) AS i, SUM(out_tok) AS o, SUM(cache_r) AS cr, SUM(cache_c) AS cc, SUM(requests) AS rq
				FROM usage_rollup
				WHERE hour_bucket > ? AND hour_bucket <= ? AND model_group IN (${REPORT_CLASSES.map(() => "?").join(", ")})
				GROUP BY hour_bucket, model_group`,
			)
			.all(opts.sinceBucket, until, ...REPORT_CLASSES) as Array<
			Record<string, unknown>
		>
	).map((r) => ({
		b: Number(r.b),
		g: String(r.g),
		i: Number(r.i),
		o: Number(r.o),
		cr: Number(r.cr),
		cc: Number(r.cc),
		rq: Number(r.rq),
	}));
	const aidRows = (
		db
			.query(
				`SELECT hour_bucket AS b, aid, domain, SUM(injected) AS inj, SUM(skipped) AS skip, SUM(tok_injected) AS tok
				FROM aid_rollup
				WHERE hour_bucket > ? AND hour_bucket <= ? AND domain != 'private'
				GROUP BY hour_bucket, aid, domain`,
			)
			.all(opts.sinceBucket, until) as Array<Record<string, unknown>>
	).map((r) => ({
		b: Number(r.b),
		aid: String(r.aid),
		domain: String(r.domain),
		inj: Number(r.inj),
		skip: Number(r.skip),
		tok: Number(r.tok),
	}));
	const windowFor = (b: number): ReportWindow => {
		let w = buckets.get(b);
		if (w === undefined) {
			w = { bucket: b, classes: {}, aids: [] };
			buckets.set(b, w);
		}
		return w;
	};
	for (const r of classes) {
		const w = windowFor(r.b);
		w.classes[r.g as ReportClass] = {
			in_tok: r.i,
			out_tok: r.o,
			cache_r: r.cr,
			cache_c: r.cc,
			requests: r.rq,
		};
	}
	for (const r of aidRows) {
		const w = windowFor(r.b);
		w.aids.push({
			aid: r.aid,
			domain: r.domain,
			injected: r.inj,
			skipped: r.skip,
			tok_injected: r.tok,
		});
	}
	const windows = [...buckets.values()]
		.filter((w) => Object.keys(w.classes).length > 0 || w.aids.length > 0)
		.sort((a, b) => a.bucket - b.bucket);
	return { team: opts.team, windows };
}

// ─── POST + cycle ─────────────────────────────────────────────────────────

/** One authenticated POST to the hub; status-only read, never throws for
 *  hub-down (degradation law — callers get ok:false). */
export async function postSelfReport(
	hubUrl: string,
	token: string,
	payload: ReportPayload,
	timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; why: string | null }> {
	try {
		const res = await fetch(`${hubUrl}/federation/usage`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				why: `hub refused: ${String(res.status)}`,
			};
		}
		return { ok: true, status: 200, why: null };
	} catch (e) {
		return { ok: false, status: 0, why: String(e) };
	}
}

export interface CycleResult {
	action: "reported" | "skipped" | "degraded";
	reason: string | null;
	windows: number;
}

/** The conjunctive opt-in gate: the operator must have configured team +
 *  hub + token, AND the pulled manifest must carry the self_report rule
 *  listing that team. Default OFF end to end — any missing piece skips. */
export function selfReportGate(
	team: string,
	hubUrl: string,
	token: string,
	manifest: { rules: Array<Record<string, unknown>> } | null,
): { go: boolean; why: string | null } {
	if (team.length === 0)
		return { go: false, why: "no team configured (BUCKLE_SPOKE_TEAM)" };
	if (hubUrl.length === 0)
		return { go: false, why: "no hub configured (BUCKLE_HUB_URL)" };
	if (token.length === 0)
		return { go: false, why: "no token (BUCKLE_SPOKE_TOKEN)" };
	const rule = selfReportRule(manifest);
	if (rule === null)
		return { go: false, why: "manifest has no self_report rule (default OFF)" };
	if (!rule.teams.includes(team))
		return { go: false, why: `team '${team}' not opted in on the hub` };
	return { go: true, why: null };
}

export interface CycleOpts {
	env?: FederationEnv;
	hubUrl?: string;
	token?: string;
	team?: string;
	db?: Database;
	govdbPath?: string;
	nowMs?: number;
}

/** One self-report cycle: gate → build (since cursor) → POST → advance the
 *  cursor. Hub-down degrades (windows stay unsent; cursor unmoved — the
 *  next cycle re-reports them). Save the cursor ONLY after a 200. */
export async function runSelfReportCycle(
	opts: CycleOpts = {},
): Promise<CycleResult> {
	const env = opts.env ?? process.env;
	const team = opts.team ?? env.BUCKLE_SPOKE_TEAM ?? "";
	const hubUrl = (opts.hubUrl ?? env.BUCKLE_HUB_URL ?? "").replace(/\/$/, "");
	const token = opts.token ?? env.BUCKLE_SPOKE_TOKEN ?? "";
	const lk = loadLastKnown(env);
	const gate = selfReportGate(team, hubUrl, token, lk?.manifest ?? null);
	if (!gate.go) return { action: "skipped", reason: gate.why, windows: 0 };
	const db =
		opts.db ??
		new Database(
			opts.govdbPath ??
				join(
					String(env.HOME ?? homedir()),
					".cache/claude-governor/governor.db",
				),
			{ readonly: true },
		);
	try {
		const now = opts.nowMs ?? Date.now();
		const cur = loadCursor(env);
		const since = cur === null ? now - 24 * 3_600_000 : cur.last_bucket;
		const payload = buildSelfReport(db, {
			team,
			sinceBucket: since,
			nowMs: now,
		});
		if (payload.windows.length === 0)
			return {
				action: "reported",
				reason: "nothing to report (empty window set)",
				windows: 0,
			};
		const post = await postSelfReport(hubUrl, token, payload);
		if (!post.ok) {
			return {
				action: "degraded",
				reason: post.why,
				windows: payload.windows.length,
			};
		}
		const last = payload.windows[payload.windows.length - 1];
		const lastBucket = last === undefined ? since : last.bucket;
		saveCursor(env, {
			last_bucket: lastBucket,
			reported_at: new Date().toISOString(),
		});
		return {
			action: "reported",
			reason: null,
			windows: payload.windows.length,
		};
	} finally {
		if (opts.db === undefined) db.close();
	}
}

/** Persist the cursor atomically after a successful report. */
export function saveCursor(env: FederationEnv, cursor: ReportCursor): void {
	atomicWrite(reportCursorPath(env), JSON.stringify(cursor));
}
