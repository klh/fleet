#!/usr/bin/env bun
// bench-routing.ts — W745 complexity-routed cost bench (route_audit-derived).
// Replays a window of the buckle route_audit ledger + the belt routing log
// through three routing strategies and reports cost-per-completed-item and
// latency per arm, then decides fixed-tier vs complexity-v3 routing.
// Read-only: no traffic sent, no behavior change. Without operator prices the
// $ dimension abstains (owner rule) — token totals are the cost evidence.
// The AC-power law does not bind: no model is served, only audits are read.
//
//	bun bin/bench-routing.ts [--days 7] [--db <buckle.db>]
//		[--routing-log <path>] [--prices <file>] [--min-n 30] [--json]

import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// ─── window row shapes (route_audit / swarm-routing.log projections) ───

export interface GateRow {
	ts: string;
	port: number; // 4000 router entry (local) · 4100 litellm · 443 direct cloud
	tier: string; // buckle e-label on the request
	ok: 0 | 1;
	durationMs: number; // end-to-end through the gate
	model: string;
}

export interface LogRow {
	ts: string;
	port: number; // specialist the router placed on (8901/8902/8903, 0 = cloud)
	durationMs: number;
	complexity: number; // n-score
	tier: string; // scored tier
	escalated: string | null;
	error: boolean;
}

export type Prices = Record<string, { in: number; out: number }>; // USD / 1M tok

/** Window token volumes from the router_usage rollup (readTokens). */
export interface TokenVolume {
	model: string; // dominant cloud model of the window
	cloudIn: number;
	cloudOut: number; // measured window volume of cloud-model tokens
}

export interface ArmReport {
	name: string;
	eligible: boolean; // false = reported but excluded from the choice (+ why)
	why: string;
	requests: number;
	completed: number;
	completedPct: number;
	localPct: number; // share kept off cloud
	latencyP50Ms: number;
	latencyP90Ms: number;
	cloudInTok: number;
	cloudOutTok: number;
	costUsd?: number; // undefined = abstain (no operator price for the model)
	per1kCompletedUsd?: number;
	elec: boolean; // local legs: marginal $ = electricity (unmetered)
	note: string;
}

export interface RouteBenchReport {
	window: { requests: number; completed: number; localPct: number };
	placements: Record<
		string,
		{ n: number; p50: number; p90: number; okRate: number }
	>;
	arms: ArmReport[];
	choice: { arm: string; why: string };
}

const CLOUD_PORT = (p: number): boolean => p === 4100 || p === 443;

/** Nearest-rank percentile of a pre-sorted array (NaN on empty). */
export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

const finitePos = (xs: number[]): number[] =>
	xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);

/** USD for a token volume at a price row; undefined without a price. */
function tokenCost(
	t: { cloudInTok: number; cloudOutTok: number },
	prices: Prices | undefined,
	model: string,
): number | undefined {
	const p = prices?.[model];
	if (!p) return undefined;
	return (t.cloudInTok * p.in + t.cloudOutTok * p.out) / 1e6;
}

/** A placement's measured latency + transport-completion from the window. */
function placeStats(
	rows: Array<{ durationMs: number; ok: number }>,
): { n: number; p50: number; p90: number; okRate: number } | null {
	if (rows.length === 0) return null;
	const d = finitePos(rows.map((r) => r.durationMs));
	if (d.length === 0) return null;
	const ok = rows.reduce((s, r) => s + r.ok, 0);
	return {
		n: rows.length,
		p50: percentile(d, 0.5),
		p90: percentile(d, 0.9),
		okRate: ok / rows.length,
	};
}

/** Local model names carry no token-priced cloud leg. */
const isCloudModel = (m: string): boolean =>
	!m.startsWith("mlx-community/") &&
	!m.startsWith("local") &&
	m !== "general" &&
	m !== "";

/**
 * Pure core: replay the audited window through the three strategies.
 * Audited arm = the window's real per-request outcomes. Fixed arms re-place
 * every request to one tier and price latency/completion from the SAME
 * window's measured per-placement medians (tier-matched for the cloud arm).
 */
export function analyze(
	gate: GateRow[],
	log: LogRow[],
	input?: { prices?: Prices; tokens?: TokenVolume },
	minN = 30,
): RouteBenchReport {
	if (gate.length < minN)
		throw new Error(
			`window too small: ${String(gate.length)} audited requests < ${String(minN)} (decision-grade floor)`,
		);

	const n = gate.length;
	const completed = gate.reduce((s, r) => s + r.ok, 0);
	const localRows = gate.filter((r) => r.port === 4000);
	const cloudRows = gate.filter((r) => CLOUD_PORT(r.port));
	const gateDur = finitePos(gate.map((r) => r.durationMs));

	// placements measured in-window
	const placements: RouteBenchReport["placements"] = {};
	const r4k = placeStats(
		localRows.map((r) => ({ durationMs: r.durationMs, ok: r.ok })),
	);
	if (r4k) placements["router:4000"] = r4k;
	const c4100 = cloudRows.filter((r) => r.port === 4100);
	const c4100All = placeStats(
		c4100.map((r) => ({ durationMs: r.durationMs, ok: r.ok })),
	);
	if (c4100All) placements["cloud:4100"] = c4100All;
	// tier-matched cloud medians (fixed:cloud per-row counterfactual)
	const tierMedian = new Map<string, number>();
	for (const t of new Set(cloudRows.map((r) => r.tier))) {
		const d = finitePos(
			cloudRows.filter((r) => r.tier === t).map((r) => r.durationMs),
		);
		if (d.length > 0) tierMedian.set(t, percentile(d, 0.5));
	}
	// router-side reason placement from the belt routing log
	const r8903 = placeStats(
		log
			.filter((r) => r.port === 8903)
			.map((r) => ({ durationMs: r.durationMs, ok: r.error ? 0 : 1 })),
	);
	if (r8903) placements["reason:8903"] = r8903;
	const cloudOkRate = c4100All?.okRate ?? 0;

	// token volumes (router_usage rollups filtered to the window by the caller)
	const prices = input?.prices;
	const tokens = input?.tokens ?? { model: "", cloudIn: 0, cloudOut: 0 };
	const { cloudIn, cloudOut } = tokens;
	const cloudModel = tokens.model;
	// fixed:cloud re-places the audited local share on the cloud leg; the
	// ledger records no tokens for local rides, so the arm's volume scales
	// the measured window volume by the request share (stated method).
	const scale = n / Math.max(1, cloudRows.length);
	const auditedCloud = tokenCost(
		{ cloudInTok: cloudIn, cloudOutTok: cloudOut },
		prices,
		cloudModel,
	);
	const arms: ArmReport[] = [
		{
			name: "complexity-v3 (audited)",
			eligible: true,
			why: "",
			requests: n,
			completed,
			completedPct: (100 * completed) / n,
			localPct: (100 * localRows.length) / n,
			latencyP50Ms: percentile(gateDur, 0.5),
			latencyP90Ms: percentile(gateDur, 0.9),
			cloudInTok: cloudIn,
			cloudOutTok: cloudOut,
			costUsd: auditedCloud,
			per1kCompletedUsd:
				auditedCloud === undefined
					? undefined
					: (1000 * auditedCloud) / Math.max(1, completed),
			elec: localRows.length > 0,
			note: `real per-request outcomes; local share ${String(localRows.length)}/${String(n)} rides the swarm (elec)`,
		},
	];

	// arm 2 — fixed:reason, every request to the strongest local :8903
	if (r8903) {
		const fc = n * r8903.okRate;
		arms.push({
			name: "fixed:reason (all → :8903)",
			eligible: false,
			why: "single specialist (maxInflight=1) absorbs the full window; ok = transport, not answer quality on hard asks",
			requests: n,
			completed: fc,
			completedPct: (100 * fc) / n,
			localPct: 100,
			latencyP50Ms: r8903.p50,
			latencyP90Ms: r8903.p90,
			cloudInTok: 0,
			cloudOutTok: 0,
			costUsd: 0,
			per1kCompletedUsd: 0,
			elec: true,
			note: "counterfactual = window's measured :8903 medians; burst arrivals queue behind the admission cap",
		});
	} else {
		arms.push({
			name: "fixed:reason (all → :8903)",
			eligible: false,
			why: "no :8903 measurements in the window",
			requests: n,
			completed: 0,
			completedPct: 0,
			localPct: 100,
			latencyP50Ms: Number.NaN,
			latencyP90Ms: Number.NaN,
			cloudInTok: 0,
			cloudOutTok: 0,
			elec: true,
			note: "abstains — placement unmeasured in this window",
		});
	}

	// arm 3 — fixed:cloud, every request to the dominant cloud leg (:4100)
	if (c4100All) {
		const cf = gate.map((r) => tierMedian.get(r.tier) ?? c4100All.p50);
		cf.sort((a, b) => a - b);
		const fc = n * cloudOkRate;
		const cost = tokenCost(
			{ cloudInTok: cloudIn * scale, cloudOutTok: cloudOut * scale },
			prices,
			cloudModel,
		);
		arms.push({
			name: "fixed:cloud (all → :4100)",
			eligible: true,
			why: "",
			requests: n,
			completed: fc,
			completedPct: (100 * fc) / n,
			localPct: 0,
			latencyP50Ms: percentile(cf, 0.5),
			latencyP90Ms: percentile(cf, 0.9),
			cloudInTok: cloudIn * scale,
			cloudOutTok: cloudOut * scale,
			costUsd: cost,
			per1kCompletedUsd:
				cost === undefined
					? undefined
					: (1000 * cost) / Math.max(1, n * cloudOkRate),
			elec: false,
			note: "counterfactual = tier-matched :4100 medians; token volume = window mean-cost × n (estimate — the ledger records no tokens for local rides)",
		});
	}

	// deterministic choice: completion parity (±1pt of best) → cheapest
	// (operator $ when priced, cloud tokens otherwise) → latency p50
	const eligible = arms.filter((a) => a.eligible && a.completedPct > 0);
	const best = Math.max(...eligible.map((a) => a.completedPct));
	const pool = eligible.filter((a) => a.completedPct >= best - 1);
	const rank = (a: ArmReport): number =>
		a.costUsd ?? (a.cloudInTok + a.cloudOutTok) / 1e6;
	const winner = pool.sort(
		(a, b) => rank(a) - rank(b) || a.latencyP50Ms - b.latencyP50Ms,
	)[0];
	const loser = pool.find((a) => a !== winner);
	const why = winner
		? `completion parity within 1pt; ${winner.name} at rank ${String(rank(winner).toFixed(6))} (${winner.costUsd === undefined ? "cloud Mtok" : "USD"}) vs ${loser ? `${loser.name} ${rank(loser).toFixed(6)}` : "no runner-up"}; latency p50 ${String(Math.round(winner.latencyP50Ms))}ms`
		: "no eligible arm";

	return {
		window: { requests: n, completed, localPct: (100 * localRows.length) / n },
		placements,
		arms,
		choice: { arm: winner?.name ?? "", why },
	};
}

// ─── window readers ───

/** route_audit window: routed, target-known rows since `since` (ISO). */
export function readGateWindow(dbPath: string, since: string): GateRow[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query(
				"SELECT ts, target_port, tier, ok, duration_ms, target_model FROM route_audit WHERE ts >= ? AND decision = 'policy' AND target_port IS NOT NULL",
			)
			.all(since) as Array<Record<string, unknown>>;
		return rows.map((r) => ({
			ts: String(r.ts),
			port: Number(r.target_port),
			tier: String(r.tier ?? ""),
			ok: r.ok === 1 ? 1 : 0,
			durationMs: Number(r.duration_ms ?? 0),
			model: String(r.target_model ?? ""),
		}));
	} finally {
		db.close();
	}
}

/** Stream the belt routing log, returning the window's scored rows. */
export async function readLogWindow(
	path: string,
	since: string,
): Promise<LogRow[]> {
	const out: LogRow[] = [];
	const file = Bun.file(path);
	if (!(await file.exists())) return out;
	const rl = createInterface(createReadStream(path, { encoding: "utf8" }));
	for await (const line of rl) {
		let j: unknown;
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof j !== "object" || j === null) continue;
		const r = j as Record<string, unknown>;
		if (typeof r.ts !== "string" || r.ts < since) continue;
		const dur = Number(r.duration_ms);
		out.push({
			ts: r.ts,
			port: Number(r.port ?? 0),
			durationMs: Number.isFinite(dur) ? dur : 0,
			complexity: Number(r.complexity ?? 0),
			tier: String(r.tier ?? ""),
			escalated: typeof r.escalated === "string" ? r.escalated : null,
			error: r.error !== undefined,
		});
	}
	return out;
}

/** Router_usage rollups for the window → token volumes + dominant model. */
export function readTokens(dbPath: string, since: string): TokenVolume {
	const db = new Database(dbPath, { readonly: true });
	try {
		const rows = db
			.query(
				"SELECT model, in_tok, out_tok, requests FROM router_usage WHERE hour_bucket >= ?",
			)
			.all(since.slice(0, 13)) as Array<Record<string, unknown>>;
		let model = "";
		let modelReq = -1;
		let cloudIn = 0;
		let cloudOut = 0;
		for (const r of rows) {
			const m = String(r.model ?? "");
			const i = Number(r.in_tok ?? 0);
			const o = Number(r.out_tok ?? 0);
			const req = Number(r.requests ?? 0);
			if (!isCloudModel(m)) continue;
			cloudIn += i;
			cloudOut += o;
			if (req > modelReq) {
				modelReq = req;
				model = m;
			}
		}
		return { model, cloudIn, cloudOut };
	} finally {
		db.close();
	}
}

// ─── CLI ───

interface Cli {
	days: number;
	db: string;
	routingLog: string;
	pricesFile: string | null;
	json: boolean;
	minN: number;
}

function parseArgs(argv: string[]): Cli {
	const get = (f: string): string | undefined => {
		const i = argv.indexOf(f);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (argv.includes("--help") || argv.length === 0) {
		console.error(
			"usage: bench-routing.ts [--days 7] [--db <buckle.db>] [--routing-log <path>] [--prices <json>] [--min-n 30] [--json]",
		);
		process.exit(argv.includes("--help") ? 0 : 1);
	}
	return {
		days: Number(get("--days") ?? 7),
		db: get("--db") ?? `${process.env.HOME}/.claude/local-llm/buckle.db`,
		routingLog:
			get("--routing-log") ??
			`${process.env.HOME}/.claude-insights/swarm-routing.log`,
		pricesFile: get("--prices") ?? null,
		json: argv.includes("--json"),
		minN: Number(get("--min-n") ?? 30),
	};
}

async function main(): Promise<void> {
	const cli = parseArgs(process.argv.slice(2));
	const since = new Date(Date.now() - cli.days * 86_400_000).toISOString();
	const gate = readGateWindow(cli.db, since);
	const log = await readLogWindow(cli.routingLog, since);
	const tok = readTokens(cli.db, since);
	let prices: Prices | undefined;
	if (cli.pricesFile)
		prices = (await Bun.file(cli.pricesFile).json()) as Prices;
	const report = analyze(gate, log, { prices, tokens: tok }, cli.minN);
	const t = (x: number): string => `${(x / 1e6).toFixed(1)}Mtok`;
	const money = (a: ArmReport): string =>
		a.costUsd === undefined
			? `${t(a.cloudInTok + a.cloudOutTok)}`
			: `$${a.costUsd.toFixed(2)}`;
	if (!cli.json) {
		console.error(
			`window: ${String(cli.days)}d since ${since} — ${String(report.window.requests)} routed requests, ${String(report.window.completed)} completed, local share ${String(report.window.localPct.toFixed(1))}%`,
		);
		for (const [name, p] of Object.entries(report.placements))
			console.error(
				`  ${name.padEnd(13)} n=${String(p.n)} p50=${String(Math.round(p.p50))}ms p90=${String(Math.round(p.p90))}ms ok=${String((100 * p.okRate).toFixed(1))}%`,
			);
		for (const a of report.arms)
			console.error(
				`  ${a.name.padEnd(26)} done=${String(a.completedPct.toFixed(1))}% local=${String(a.localPct.toFixed(1))}% p50=${String(Math.round(a.latencyP50Ms))}ms p90=${String(Math.round(a.latencyP90Ms))}ms cost=${money(a)}${a.elec ? "+elec" : ""}${a.eligible ? "" : ` [excluded: ${a.why}]`}`,
			);
		console.error(`choice: ${report.choice.arm} — ${report.choice.why}`);
	}
	console.log(JSON.stringify(report));
}

if (import.meta.main) await main();
