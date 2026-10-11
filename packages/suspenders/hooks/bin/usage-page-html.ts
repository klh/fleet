// hooks/bin/usage-page-html.ts — W152: /usage rebuilt Grafana-grade on
// vendored uPlot (the time-series engine behind Grafana's charts, MIT).
// Server-rendered chrome + embedded uPlot-ready JSON payload; the client
// renderer (usage-charts.ts) draws the panels. NO CDN — uPlot's IIFE + css
// are vendored under hooks/bin/vendor/ (license headers preserved) and
// inlined, so the LAN-only board renders with the network down.
//
// Panels: stat tiles row → stacked-area timeline by model group with a
// 7/28d timeframe selector → hour-of-day histogram → per-actor table with
// inline stacked-by-model bars + per-model drill-down → aid-ROI panel that
// degrades honestly until aid_events land (W142 seam). Team/DEPARTMENT
// filter chips are server-side and cut the whole dashboard (the report is
// filtered in buildUsageReport), and every view is a shareable URL: days,
// team, dept all live in the query string.
//
// W127 dataviz discipline kept: form first, categorical color by identity
// in FIXED group order (never cycled — flash is always blue), palette
// validated against surface var(--klh-surface), recessive grid, muted axis ink,
// tabular-nums, native <title> hovers on the non-uPlot marks, dark palette.
import { GROUPS, type UsageReport } from "../lib/usage.ts";
import { ACTIVITIES, type ActivityReport } from "./activity-harvest.ts";
// W652.3: palette/esc/fmtTok/tiles/shell ride the shared chrome (one source
// for both usage dashboards; W171's per-page copies retired)
import {
	esc,
	fmtTok,
	legendHtml,
	SLOT,
	tilesRow,
	usagePageShell,
} from "./usage-chrome.ts";

// W243 activity hues — fixed per bucket (color follows the entity), same
// validated-dark family as the SLOT palette
const ACT_COLOR: Record<string, string> = {
	context: "#3987e5",
	planning: "#199e70",
	code: "#d95926",
	communicating: "#c98500",
};

// ─── uPlot-ready payload (embedded as #usage-data JSON) ──────────────────
// Columnar on purpose: timeline = [x, flash, full, luna, local, other] with
// x in unix SECONDS (uPlot's native shape), byHour = [0..23, tokens]. The
// client renderer mounts them directly — zero reshaping in browser JS.
const chartPayload = (r: UsageReport): string =>
	JSON.stringify({
		groups: GROUPS,
		slot: SLOT,
		timeline: [
			r.timeline.map((p) => Math.round(p.bucket / 1000)),
			...GROUPS.map((g) => r.timeline.map((p) => p.groups[g])),
		],
		byHour: [r.byHour.map((h) => h.hour), r.byHour.map((h) => h.tokens)],
	});

// ─── stat tiles row ───────────────────────────────────────────────────────
function tilesHtml(r: UsageReport): string {
	const byModel = new Map<string, number>();
	for (const a of r.actors)
		for (const m of a.byModel)
			byModel.set(m.model, (byModel.get(m.model) ?? 0) + m.tok);
	const topModel = [...byModel.entries()].sort((x, y) => y[1] - x[1])[0];
	const cells: [string, string][] = [
		["ACTIVE ACTORS", String(r.actors.length)],
		["TOTAL TOKENS", fmtTok(r.totals.tok)],
		["REQUESTS", fmtTok(r.totals.rq)],
		["MOST-USED MODEL", topModel ? esc(topModel[0]) : "—"],
		["OUTPUT TOK/S (RECENT)", String(r.rate.tokPerSec)],
	];
	return tilesRow(cells);
}

// ─── filter row: timeframe + team/department chips (server-side) ──────────
// State is the query string itself — chips toggle by rewriting only their
// own param, so any dashboard view is a shareable URL. Facet lists come
// from the UNFILTERED tag universe (report.facets) so chips stay switchable
// while a filter is active.
function filterHtml(
	r: UsageReport,
	days: number,
	team: string,
	dept: string,
	includeDemo: boolean,
): string {
	const teams = r.facets.teams;
	const depts = r.facets.depts;
	const href = (over: {
		days?: number;
		team?: string | null;
		dept?: string | null;
		includeDemo?: boolean;
	}): string => {
		const p = new URLSearchParams();
		p.set("days", String(over.days ?? days));
		const t = over.team !== undefined ? over.team : team;
		if (t) p.set("team", t);
		const d = over.dept !== undefined ? over.dept : dept;
		if (d) p.set("dept", d);
		if (over.includeDemo ?? includeDemo) p.set("includeDemo", "true");
		return `/usage?${p.toString()}`;
	};
	const tLinks = [7, 28]
		.map(
			(dd) =>
				`<a class="ufilter${dd === days ? " on" : ""}" href="${esc(href({ days: dd }))}">${dd}d</a>`,
		)
		.join("");
	const chip = (v: string, cur: string, key: "team" | "dept"): string =>
		`<a class="ufchip${v && v === cur ? " on" : ""}" href="${esc(href({ [key]: v || null }))}">${v ? esc(v) : "all"}</a>`;
	const group = (label: string, inner: string): string =>
		`<span class="ufgroup" data-label="${label}">${inner}</span>`;
	const teamChips = group(
		"team",
		["", ...teams].map((v) => chip(v, team, "team")).join(""),
	);
	const deptChips = group(
		"dept",
		["", ...depts].map((v) => chip(v, dept, "dept")).join(""),
	);
	const active = [
		team ? `team=${team}` : "",
		dept ? `dept=${dept}` : "",
	].filter(Boolean);
	const labels = active.length
		? ` <span class="uon">dashboard filtered: ${esc(active.join(", "))}</span>`
		: "";
	return `<div class="ufilters">${group(
		"window",
		tLinks,
	)}${teamChips}${deptChips}${labels}${r.provenance?.source === "transcript-v2" ? "" : `<a class="ufilter${includeDemo ? " on" : ""}" href="${esc(href({ includeDemo: !includeDemo }))}">${includeDemo ? "Hide synthetic demo usage" : "Include synthetic demo usage"}</a>`}<span class="uon">${includeDemo && r.provenance?.source !== "transcript-v2" ? "Synthetic demo usage included" : `${r.provenance?.source === "transcript-v2" ? "Verified transcript usage" : "Legacy aggregate usage"} · ${r.demo?.excludedActors ?? 0} synthetic actors excluded${r.provenance?.legacy ? ` · Legacy aggregate retained separately (${fmtTok(r.provenance.legacy.tok)} tokens)` : ""}`}</span></div>`;
}

// ─── per-actor drill-down table (the report arrives pre-filtered) ─────────
function actorRows(r: UsageReport): string {
	if (!r.actors.length) return `<p class="uempty">no actors in this filter</p>`;
	const maxTok = Math.max(1, ...r.actors.map((a) => a.totals.tok));
	const rows = r.actors.map((a) => {
		const tags = (a.tags ?? {}) as Record<string, string>;
		const chips = ["team", "department"]
			.filter((k) => tags[k])
			.map((k) => `<span class="uchip">${esc(tags[k])}</span>`)
			.join("");
		const segs = GROUPS.map((g) => {
			const tok = a.byModel
				.filter((m) => m.group === g)
				.reduce((x, m) => x + m.tok, 0);
			if (!tok) return "";
			const pct = (a.totals.tok ? (tok / a.totals.tok) * 100 : 0).toFixed(2);
			return `<i style="width:${pct}%;background:${SLOT[g]}" title="${g}: ${fmtTok(tok)} tok"></i>`;
		}).join("");
		const models = a.byModel
			.map(
				(m) =>
					`<tr><td><i class="udot" style="background:${SLOT[m.group]}"></i>${esc(m.model)}</td><td class="unum">${fmtTok(m.tok)}</td><td class="unum">${fmtTok(m.rq)}</td></tr>`,
			)
			.join("");
		const barW = Math.max(2, (a.totals.tok / maxTok) * 100);
		const detail = `<tr class="udetail"><td colspan="4"><details><summary>per-model</summary><table class="umtab"><thead><tr><th>model</th><th class="unum">tokens</th><th class="unum">req</th></tr></thead><tbody>${models}</tbody></table></details></td></tr>`;
		const main = `<tr class="uact"><td><b>${esc(a.actor)}</b>${a.demo ? '<span class="uchip">synthetic demo</span>' : ""}${chips}</td><td><div class="ubar" style="width:${barW.toFixed(1)}%">${segs}</div></td><td class="unum">${fmtTok(a.totals.tok)}</td><td class="unum">${fmtTok(a.totals.rq)}</td></tr>`;
		return main + detail;
	});
	return rows.join("");
}

// ─── aid-ROI panel: the W142 seam, honest when empty ──────────────────────
function aidsHtml(r: UsageReport): string {
	if (!r.aids)
		return `<div class="upanel"><h2>AID ROI · W142 SEAM</h2><p class="uempty">no aid events yet — this panel lights up when aid_events land (knowledge-aids metering)</p></div>`;
	const roll = r.aids.rollup
		.map(
			(a) =>
				`<tr><td><b>${esc(a.aid)}</b></td><td>${esc(a.domain)}</td><td class="unum">${fmtTok(a.injected)}</td><td class="unum">${fmtTok(a.skipped)}</td><td class="unum">${fmtTok(a.tok_injected)}</td></tr>`,
		)
		.join("");
	return `<div class="upanel"><h2>AID ROI · INJECTED VS SKIPPED</h2><p class="ufoot">${r.aids.join.length} aid-joined session hours in this filter · aggregate table covers all fleet actors because aid_rollup has no actor dimension · join: aid_events(sid) ⋈ sessions(sid→actor) ⋈ usage_rollup(actor, hour)</p><table class="uacts"><thead><tr><th>aid</th><th>domain</th><th class="unum">injected</th><th class="unum">skipped</th><th class="unum">tok injected</th></tr></thead><tbody>${roll}</tbody></table></div>`;
}

// ─── W243 activity panel: weekly classify + context-share per lane ────────
function activityHtml(a: ActivityReport): string {
	const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
	const cell = (share: number, key: string): string => {
		if (!share) return `<span class="uempty">—</span>`;
		return `<div class="ubar" style="width:100%"><i style="width:${pct(share)};background:${ACT_COLOR[key] ?? "#888"}" title="${key}: ${pct(share)}"></i></div><span class="unum">${pct(share)}</span>`;
	};
	const weekRow = (w: {
		week: number;
		cost: number;
		shares: Record<string, number>;
		orientShare: number;
	}): string =>
		`<tr><td>${new Date(w.week).toISOString().slice(0, 10)}</td><td class="unum">${fmtTok(Math.round(w.cost))}</td><td style="width:44%">${ACTIVITIES.map((k) => cell(w.shares[k], k)).join("<span class='usep'>·</span>")}</td><td class="unum">${pct(w.orientShare)}</td></tr>`;
	const laneRow = (ar: {
		actor: string;
		requests: number;
		searchesPerReq: number;
		cost: number;
		contextShare: number;
		orientShare: number;
	}): string =>
		`<tr><td><b>${esc(ar.actor)}</b></td><td>${cell(ar.contextShare, "context")}</td><td class="unum">${pct(ar.orientShare)}</td><td class="unum">${ar.searchesPerReq.toFixed(2)}</td><td class="unum">${fmtTok(Math.round(ar.cost))}</td><td class="unum">${fmtTok(ar.requests)}</td></tr>`;
	const weeks = a.weekly.map(weekRow).join("");
	const lanes = a.actors.length
		? a.actors.map(laneRow).join("")
		: `<tr><td colspan="6" class="uempty">no classified activity yet — first harvest fills this table</td></tr>`;
	return `<div class="upanel"><h2>ACTIVITY · DECANT SHAPE (W243)</h2><p class="ufoot">cost shares on the pricing shape in ${a.pricing.in}x / cacheW ${a.pricing.cacheC}x / cacheR ${a.pricing.cacheR}x / out ${a.pricing.out}x · requestId dedup: largest-output snapshot · searches normalized per request</p><table class="uacts"><thead><tr><th>week</th><th class="unum">cost</th><th>context · planning · code · communicating</th><th class="unum">orient</th></tr></thead><tbody>${weeks}</tbody></table><table class="uacts" style="margin-top:10px"><thead><tr><th>lane</th><th>context share</th><th class="unum">orient</th><th class="unum">searches/req</th><th class="unum">cost</th><th class="unum">req</th></tr></thead><tbody>${lanes}</tbody></table></div>`;
}

// ─── page assembly ───────────────────────────────────────────────────────
export function usagePage(
	r: UsageReport,
	opts: {
		days: number;
		team?: string;
		dept?: string;
		includeDemo?: boolean;
		activity?: ActivityReport;
	} = { days: r.days },
): string {
	const team = opts.team ?? "";
	const dept = opts.dept ?? "";
	const head =
		`<h1 class="utitle">USAGE</h1>` +
		filterHtml(
			r,
			r.days,
			team,
			dept,
			opts.includeDemo ?? r.demo?.included ?? false,
		) +
		tilesHtml(r);
	const timeline = `<div class="upanel"><div class="uhead"><h2>TOKENS · STACKED BY MODEL GROUP</h2><p class="ufoot">hover = values · drag = zoom · double-click = reset</p></div>${legendHtml()}<div id="u-timeline" class="uchart"></div></div>`;
	const hours = `<div class="upanel"><h2>WHEN THE FLEET WORKS · HOUR OF DAY (LOCAL)</h2><div id="u-hours" class="uchart"></div></div>`;
	const tbl = `<div class="upanel"><h2>ACTORS</h2><table class="uacts"><thead><tr><th>actor</th><th style="width:38%">tokens by model group</th><th class="unum">total</th><th class="unum">req</th></tr></thead><tbody>${actorRows(r)}</tbody></table></div>`;
	const activity = opts.activity
		? activityHtml(opts.activity)
		: `<div class="upanel"><h2>ACTIVITY · DECANT SHAPE (W243)</h2><p class="uempty">meter not wired on this route — pass activity report to usagePage</p></div>`;
	const back = `<div class="uback"><a href="/">&larr; fleet board</a><span class="uwin">${r.days}d window · buckets UTC-hourly · charts read usage_rollup · filter state lives in the URL — copy the address bar to share this exact view</span></div>`;
	return usagePageShell({
		title: "FLEET USAGE",
		body: `${back}${head}${timeline}${hours}${tbl}${activity}${aidsHtml(r)}`,
		payload: chartPayload(r),
	});
}
