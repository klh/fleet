// hooks/bin/federation-usage-html.ts — W171: the hub-side GLOBAL usage/aid
// dashboard — W152 renderers over the hub-stored federation rollups. Reads
// GET /federation/usage (hub-admin credential; the board fetches it
// server-side — the browser never sees the key). Aggregate-only by
// construction: the hub stores model-CLASS buckets, never names or
// content; the page degrades honestly until spokes report (default OFF
// until an operator opts teams in on the hub policy).
import { GROUPS } from "../lib/usage.ts";
// W171: esc/fmtTok shared with the local /usage page (same dataviz chrome).
import { esc, fmtTok } from "./usage-page-html.ts";
import { TOPBAR_JS, topbar } from "./console-html.ts";
import { USAGE_CHART_JS } from "./usage-charts.ts";
import { THEME_HEAD } from "../lib/theme.ts";
import { readFileSync } from "node:fs";

// uPlot 1.6.32 (MIT) — vendored, inlined (offline LAN, never CDN).
const UPILOT_SRC = readFileSync(
	new URL("./vendor/uPlot.iife.min.js", import.meta.url),
	"utf8",
);
const UPLOT_CSS = readFileSync(
	new URL("./vendor/uPlot.min.css", import.meta.url),
	"utf8",
);

const SLOT: Record<string, string> = {
	flash: "#3987e5",
	full: "#d95926",
	luna: "#199e70",
	local: "#c98500",
	other: "#d55181",
};

export interface FedPageWindow {
	bucket: number;
	team: string;
	spoke: string;
	classes: Record<string, ClassRow2>;
}

export interface ClassRow2 {
	in_tok: number;
	out_tok: number;
	cache_r: number;
	cache_c: number;
	requests: number;
}

export interface FedPageAid {
	bucket: number;
	team: string;
	spoke: string;
	aid: string;
	domain: string;
	injected: number;
	skipped: number;
	tok_injected: number;
}

export interface FedPageReport {
	days: number;
	spokes: number;
	windows: FedPageWindow[];
	aids: FedPageAid[];
}

// ─── aggregation over the rollup windows ──────────────────────────────────
const zeroGroups = (): Record<string, number> => ({
	flash: 0,
	full: 0,
	luna: 0,
	local: 0,
	other: 0,
});

/** Per-bucket totals across every spoke+team → uPlot columnar timeline
 *  [x, flash, full, luna, local, other]. */
function timelineData(r: FedPageReport): number[][] {
	const byBucket = new Map<number, Record<string, number>>();
	const keys = new Set<number>();
	for (const w of r.windows) keys.add(w.bucket);
	const sorted = [...keys].sort((a, b) => a - b);
	const xs = sorted.map((b) => Math.round(b / 1000));
	for (const w of r.windows) {
		const g = byBucket.get(w.bucket);
		if (g === undefined) continue;
		for (const [cls, m] of Object.entries(w.classes)) {
			g[cls] = (g[cls] ?? 0) + m.in_tok + m.out_tok + m.cache_r + m.cache_c;
		}
	}
	return [
		xs,
		...GROUPS.map((g) =>
			sorted.map((b) => {
				const cell = byBucket.get(b);
				return cell === undefined ? 0 : (cell[g] ?? 0);
			}),
		),
	];
}

/** Hour-of-day (LOCAL) histogram over the same totals → [0..23, tokens]. */
function byHourData(r: FedPageReport): number[][] {
	const hours = Array.from({ length: 24 }, () => 0);
	for (const w of r.windows) {
		const when = new Date(w.bucket);
		const total = Object.values(w.classes).reduce(
			(a, m) => a + m.in_tok + m.out_tok + m.cache_r + m.cache_c,
			0,
		);
		hours[when.getHours()] += total;
	}
	return [hours.map((_, i) => i), hours];
}

// ─── page sections ────────────────────────────────────────────────────────
function tilesHtml(r: FedPageReport): string {
	const byClass = zeroGroups();
	let rq = 0;
	let windows = 0;
	for (const w of r.windows) {
		windows++;
		for (const [cls, m] of Object.entries(w.classes)) {
			byClass[cls] =
				(byClass[cls] ?? 0) + m.in_tok + m.out_tok + m.cache_r + m.cache_c;
		}
		rq += Object.values(w.classes).reduce((a, m) => a + m.requests, 0);
	}
	const top = Object.entries(byClass)
		.sort((a, b) => b[1] - a[1])
		.find(([, v]) => v > 0);
	const cells: [string, string][] = [
		["REPORTING SPOKES", String(r.spokes)],
		["TOTAL TOKENS", fmtTok(Object.values(byClass).reduce((a, b) => a + b, 0))],
		["REQUESTS", fmtTok(rq)],
		["TOP MODEL CLASS", top === undefined ? "—" : top[0]],
		["WINDOWS", String(windows)],
	];
	return `<div class="utiles">${cells
		.map(
			([k, v]) =>
				`<div class="utile"><div class="uv">${v}</div><div class="uk">${k}</div></div>`,
		)
		.join("")}</div>`;
}

function filtersHtml(days: number): string {
	const tLinks = [7, 28, 90]
		.map(
			(dd) =>
				`<a class="ufilter${dd === days ? " on" : ""}" href="/federation-usage?days=${String(dd)}">${String(dd)}d</a>`,
		)
		.join("");
	return `<div class="ufilters"><span class="ufgroup" data-label="window">${tLinks}</span></div>`;
}

/** Per-spoke table: one row per (spoke, team), class-segmented bar. */
function spokesHtml(r: FedPageReport): string {
	if (r.windows.length === 0)
		return `<div class="upanel"><h2>SPOKES</h2><p class="uempty">no spokes reporting — aggregate self-report is opt-in per team (default OFF; the hub policy lists opted-in teams under gateway.federation.self_report.teams)</p></div>`;
	const per = new Map<
		string,
		{ team: string; classes: Record<string, number>; rq: number }
	>();
	for (const w of r.windows) {
		let row = per.get(w.spoke);
		if (row === undefined) {
			row = { team: w.team, classes: zeroGroups(), rq: 0 };
			per.set(w.spoke, row);
		}
		for (const [cls, m] of Object.entries(w.classes)) {
			row.classes[cls] =
				(row.classes[cls] ?? 0) + m.in_tok + m.out_tok + m.cache_r + m.cache_c;
			row.rq += m.requests;
		}
	}
	const rows = [...per.entries()]
		.map(([spoke, agg]) => {
			const total = Object.values(agg.classes).reduce((a, b) => a + b, 0);
			const maxTok = Math.max(
				1,
				...[...per.values()].map((x) =>
					Object.values(x.classes).reduce((a, b) => a + b, 0),
				),
			);
			const segs = GROUPS.map((g) => {
				const tok = agg.classes[g] ?? 0;
				if (tok === 0) return "";
				const pct = total > 0 ? ((tok / total) * 100).toFixed(2) : "0";
				return `<i style="width:${pct}%;background:${SLOT[g]}" title="${g}: ${fmtTok(tok)} tok"></i>`;
			}).join("");
			const barW = Math.max(2, (total / maxTok) * 100);
			return `<tr><td><b>${esc(spoke)}</b><span class="uchip">${esc(agg.team)}</span></td><td><div class="ubar" style="width:${barW.toFixed(1)}%">${segs}</div></td><td class="unum">${fmtTok(total)}</td><td class="unum">${fmtTok(agg.rq)}</td></tr>`;
		})
		.join("");
	return `<div class="upanel"><h2>SPOKES</h2><table class="uacts"><thead><tr><th>spoke</th><th style="width:38%">tokens by model class</th><th class="unum">total</th><th class="unum">req</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Aid-ROI-over-federation panel: per aid+domain sums across spokes. */
function aidsHtml(r: FedPageReport): string {
	if (r.aids.length === 0)
		return `<div class="upanel"><h2>AID ROI · FEDERATED</h2><p class="uempty">no aid aggregates reported yet — spokes with opted-in teams include aid_rollup sums (private-domain rows never leave the spoke)</p></div>`;
	const per = new Map<
		string,
		{
			aid: string;
			domain: string;
			inj: number;
			skip: number;
			tok: number;
		}
	>();
	for (const a of r.aids) {
		const key = `${a.aid}|${a.domain}`;
		let row = per.get(key);
		if (row === undefined) {
			row = { aid: a.aid, domain: a.domain, inj: 0, skip: 0, tok: 0 };
			per.set(key, row);
		}
		row.inj += a.injected;
		row.skip += a.skipped;
		row.tok += a.tok_injected;
	}
	const rows = [...per.values()]
		.sort((a, b) => b.tok - a.tok)
		.map(
			(a) =>
				`<tr><td><b>${esc(a.aid)}</b></td><td>${esc(a.domain)}</td><td class="unum">${fmtTok(a.inj)}</td><td class="unum">${fmtTok(a.skip)}</td><td class="unum">${fmtTok(a.tok)}</td></tr>`,
		)
		.join("");
	return `<div class="upanel"><h2>AID ROI · FEDERATED</h2><p class="ufoot">spoke-reported sums · private-domain rows are filtered spoke-side (domain separation)</p><table class="uacts"><thead><tr><th>aid</th><th>domain</th><th class="unum">injected</th><th class="unum">skipped</th><th class="unum">tok injected</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ─── page assembly (the W152 u* chrome, scoped to this page) ─────────────
const U_CSS = `
.utiles { display:flex; gap:10px; flex-wrap:wrap; margin:14px 0; }
.utile { flex:1 1 150px; background:var(--klh-surface); border:1px solid var(--klh-edge-soft); border-radius:3px; padding:10px 14px; }
.uv { font-size:22px; font-weight:600; color:var(--klh-ink); font-variant-numeric:tabular-nums; word-break:break-all; }
.uk { font-size:10px; color:var(--klh-dim); text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
.uback { display:flex; gap:16px; align-items:baseline; margin:12px 0 0; }
.uwin { font-size:10.5px; color:var(--klh-dim); }
.upanel { background:var(--klh-surface); border:1px solid var(--klh-edge-soft); border-radius:3px; padding:12px 14px 10px; margin-bottom:14px; }
.upanel h2 { margin:0 0 6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); }
.upanel .uhead { display:flex; align-items:baseline; gap:12px; }
.upanel .uhead .ufoot { margin:0; }
.ulegend { display:flex; gap:14px; font-size:11px; color:var(--klh-ink-2); margin:0 0 8px; flex-wrap:wrap; }
.ulegend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
.ufilters { display:flex; gap:18px; align-items:center; margin:0 0 14px; flex-wrap:wrap; }
.ufgroup::before { content:attr(data-label); font-size:9.5px; color:var(--klh-dim); text-transform:uppercase; letter-spacing:.06em; }
.ufilter { font-size:11px; color:var(--klh-dim); text-decoration:none; border:1px solid var(--klh-edge); border-radius:2px; padding:2px 9px; }
.ufilter.on { color:var(--klh-accent); border-color:var(--klh-accent); }
table.uacts { width:100%; border-collapse:collapse; font-size:12px; }
table.uacts td, table.uacts th { padding:6px 8px; border-bottom:1px solid var(--klh-rule); text-align:left; }
.unum { text-align:right; font-variant-numeric:tabular-nums; color:var(--klh-ink-2); white-space:nowrap; }
.ubar { display:flex; height:12px; border-radius:3px; overflow:hidden; min-width:2px; }
.ubar i { display:block; height:100%; }
.uchip { font-size:10px; color:var(--klh-dim); border:1px solid var(--klh-edge); border-radius:2px; padding:1px 6px; margin-left:6px; }
.uempty { color:var(--klh-dim); font-size:12px; }
.ufoot { font-size:10.5px; color:var(--klh-dim); margin:2px 0 8px; }
.uchart { width:100%; }
`;

/** The federation usage dashboard page. */
export function federationUsagePage(
	r: FedPageReport,
	opts: { degraded?: string | null } = {},
): string {
	const degraded = opts.degraded ?? null;
	const timeline = `<div class="upanel"><div class="uhead"><h2>GLOBAL TOKENS · STACKED BY MODEL CLASS</h2><p class="ufoot">hover = values · drag = zoom · double-click = reset</p></div>${legendHtml()}<div id="u-timeline" class="uchart"></div></div>`;
	const hours = `<div class="upanel"><h2>WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)</h2><div id="u-hours" class="uchart"></div></div>`;
	const note =
		degraded === null
			? `<span class="uwin">aggregate self-report, opt-in per team — the hub stores model-CLASS buckets only; private-domain aggregates never arrive</span>`
			: `<span class="uon">hub rollups unavailable: ${esc(degraded)}</span>`;
	const head =
		`<h1 class="utitle">FEDERATED USAGE</h1>` +
		`<div class="uback"><a href="/">&larr; fleet board</a>${note}</div>` +
		filtersHtml(r.days) +
		tilesHtml(r);
	const payload = JSON.stringify({
		groups: GROUPS,
		slot: SLOT,
		timeline: timelineData(r),
		byHour: byHourData(r),
	});
	const scripts = `<style>${UPLOT_CSS}</style><script type="application/json" id="usage-data">${payload}</script><script>${TOPBAR_JS}</script><script>${USAGE_CHART_JS}</script>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>FEDERATED USAGE</title>${THEME_HEAD}<style>body{background:var(--klh-bg);color:var(--klh-ink);font:13px/1.45 var(--klh-font-sans);margin:0;padding:0 20px 28px;}a{color:var(--klh-accent)}.utitle{font-size:14px;letter-spacing:.08em;margin:14px 0 10px;color:var(--klh-ink)}${U_CSS}</style></head><body>${topbar("suspenders")}<main style="max-width:1060px;margin:0 auto">${head}${timeline}${hours}${spokesHtml(r)}${aidsHtml(r)}</main><script>${UPILOT_SRC}</script>${scripts}</body></html>`;
}

function legendHtml(): string {
	const items = GROUPS.map(
		(g) => `<span><i style="background:${SLOT[g]}"></i>${g}</span>`,
	);
	return `<div class="ulegend">${items.join("")}</div>`;
}
