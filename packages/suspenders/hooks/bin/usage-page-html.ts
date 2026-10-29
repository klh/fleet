// hooks/bin/usage-page-html.ts — W152: /usage rebuilt Grafana-grade on
// vendored uPlot (the time-series engine behind Grafana's charts, MIT).
// Server-rendered chrome + embedded uPlot-ready JSON payload; the client
// renderer (<klh-usage-charts> in board-html/usage-panels.ts) draws the
// panels. NO CDN — uPlot's IIFE + css are vendored under hooks/bin/vendor/
// (license headers preserved) and inlined, so the LAN-only board renders
// with the network down.
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
//
// W652.3.1: the panels (tiles/actors/aids/activity) moved onto Lit web
// components (board-html/usage-panels.ts, the W184 staged migration) — this
// module now SHAPES the payload's `panels` slices and emits static hosts;
// no more per-request panel HTML strings. Filters stay server-side native
// links (URL state must work without JS).

import { ACTIVITIES, type ActivityReport } from "../lib/activity-harvest.ts";
import type { CrossHubReport } from "../lib/cross-hub-usage.ts";
import { GROUPS, type UsageReport } from "../lib/usage.ts";
// W652.3: palette/esc/fmtTok/tiles/shell ride the shared chrome (one source
// for both usage dashboards; W171's per-page copies retired)
import {
	fmtTok,
	SLOT,
	type UsageActivityCell,
	type UsageActivityPanel,
	type UsageActorsPanel,
	type UsageAidsPanel,
	type UsageChip,
	type UsageCoveragePanel,
	type UsageCrossHubPanel,
	type UsageHeaderPanel,
	type UsageSeg,
	type UsageTile,
	usagePageShell,
} from "./usage-chrome.ts";
import { coverageData } from "./usage-coverage-data.ts";

// ─── uPlot-ready payload (embedded as #usage-data JSON) ──────────────────
// Columnar on purpose: timeline = [x, flash, full, luna, local, other] with
// x in unix SECONDS (uPlot's native shape), byHour = [0..23, tokens]. The
// client renderer mounts them directly — zero reshaping in browser JS.
// W652.3.1: the `panels` key carries the display-shaped slices the Lit
// components (board-html/usage-panels.ts) render client-side.
export const chartPayload = (
	r: UsageReport,
	header: UsageHeaderPanel,
	coverage: UsageCoveragePanel,
	activity?: ActivityReport,
	crosshub?: UsageCrossHubPanel,
): string =>
	JSON.stringify({
		groups: GROUPS,
		slot: SLOT,
		timeline: [
			r.timeline.map((p) => Math.round(p.bucket / 1000)),
			...GROUPS.map((g) => r.timeline.map((p) => p.groups[g])),
		],
		byHour: [r.byHour.map((h) => h.hour), r.byHour.map((h) => h.tokens)],
		panels: {
			header,
			tiles: tilesData(r),
			actors: actorsData(r),
			aids: aidsData(r),
			coverage,
			activity: activity
				? activityData(activity)
				: {
						empty:
							"meter not wired on this route — pass activity report to usagePage",
					},
			crosshub,
		},
	}).replaceAll("<", "\\u003c");

// ─── stat tiles → display-shaped slice for <klh-usage-tiles> ──────────────
const tilesData = (r: UsageReport): UsageTile[] => {
	const byModel = new Map<string, number>();
	for (const a of r.actors)
		for (const m of a.byModel)
			byModel.set(m.model, (byModel.get(m.model) ?? 0) + m.tok);
	const topModel = [...byModel.entries()].sort((x, y) => y[1] - x[1])[0];
	const hasRecentUsage = r.timeline.some(
		(point) =>
			point.bucket >= r.toBucket - 86_400_000 &&
			Object.values(point.groups).some((tokens) => tokens > 0),
	);
	return [
		{ k: "ACTORS IN WINDOW", v: String(r.actors.length) },
		{ k: "TOTAL TOKENS", v: fmtTok(r.totals.tok) },
		{ k: "REQUESTS", v: fmtTok(r.totals.rq) },
		{ k: "MOST-USED MODEL", v: topModel ? topModel[0] : "—" },
		{
			k: hasRecentUsage
				? `OUTPUT TOK/S · LAST RECORDED HOUR (${new Date(r.rate.hourBucket).toISOString().slice(0, 16).replace("T", " ")} UTC)`
				: "OUTPUT TOK/S · NO RECENT USAGE",
			v: hasRecentUsage ? String(r.rate.tokPerSec) : "—",
		},
	];
};

// ─── header slice: timeframe + team/department chips (server-side) ────────
// State is the query string itself — chips toggle by rewriting only their
// own param, so any dashboard view is a shareable URL. Facet lists come
// from the UNFILTERED tag universe (report.facets) so chips stay switchable
// while a filter is active. W695.3.4: the links are native <a href> inside
// <klh-usage-header>; this module only shapes the slice.
function headerData(
	r: UsageReport,
	days: number,
	team: string,
	dept: string,
	includeDemo: boolean,
): UsageHeaderPanel {
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
	const chips = (
		vals: string[],
		cur: string,
		key: "team" | "dept",
	): UsageChip[] =>
		["", ...vals].map((v) => ({
			label: v || "all",
			href: href({ [key]: v || null }),
			on: !!v && v === cur,
		}));
	const active = [
		team ? `team=${team}` : "",
		dept ? `dept=${dept}` : "",
	].filter(Boolean);
	const v2 = r.provenance?.source === "transcript-v2";
	const legacy = r.provenance?.legacy
		? ` · Legacy aggregate retained separately (${fmtTok(r.provenance.legacy.tok)} tokens)`
		: "";
	return {
		back: `${r.days}d window · buckets UTC-hourly · charts read usage_rollup · filter state lives in the URL — copy the address bar to share this exact view`,
		windows: [7, 28].map((dd) => ({
			label: `${dd}d`,
			href: href({ days: dd }),
			on: dd === days,
		})),
		teams: chips(r.facets.teams, team, "team"),
		depts: chips(r.facets.depts, dept, "dept"),
		filtered: active.length
			? `dashboard filtered: ${active.join(", ")}`
			: undefined,
		status:
			includeDemo && !v2
				? "Synthetic demo usage included"
				: `${v2 ? "Verified transcript usage" : "Legacy aggregate usage"}${legacy}`,
	};
}

// ─── per-actor slice (the report arrives pre-filtered) ────────────────────
const actorsData = (r: UsageReport): UsageActorsPanel => ({
	rows: r.actors.map((a) => {
		const tags = (a.tags ?? {}) as Record<string, string>;
		const chips = ["team", "department"]
			.filter((k) => tags[k])
			.map((k) => tags[k]);
		const maxTok = Math.max(1, ...r.actors.map((x) => x.totals.tok));
		const segs: UsageSeg[] = [];
		for (const g of GROUPS) {
			const tok = a.byModel
				.filter((m) => m.group === g)
				.reduce((x, m) => x + m.tok, 0);
			if (!tok) continue;
			segs.push({ g, tok });
		}
		const models = a.byModel.map((m) => ({
			m: m.model,
			g: m.group,
			tok: m.tok,
			rq: m.rq,
		}));
		return {
			actor: a.actor,
			demo: a.demo,
			chips,
			barW: Math.max(2, (a.totals.tok / maxTok) * 100),
			segs,
			models,
			total: a.totals.tok,
			rq: a.totals.rq,
		};
	}),
});

// ─── aid-ROI slice: the W142 seam, honest when empty ──────────────────────
const aidsData = (r: UsageReport): UsageAidsPanel => {
	if (!r.aids)
		return {
			title: "AID ROI · W142 SEAM",
			empty:
				"no aid events yet — this panel lights up when aid_events land (knowledge-aids metering)",
		};
	const roll = r.aids.rollup.map((a) => ({
		aid: a.aid,
		domain: a.domain,
		inj: a.injected,
		skip: a.skipped,
		tok: a.tok_injected,
	}));
	return {
		title: "AID ROI · INJECTED VS SKIPPED",
		foot: `${r.aids.join.length} aid-joined session hours in this filter · aggregate table covers all fleet actors because aid_rollup has no actor dimension · join: aid_events(sid) ⋈ sessions(sid→actor) ⋈ usage_rollup(actor, hour)`,
		rows: roll,
	};
};

// ─── W243 activity slice: weekly classify + context-share per lane ────────
const activityData = (a: ActivityReport): UsageActivityPanel => {
	const cell = (key: string, share: number): UsageActivityCell => ({
		key,
		share,
	});
	return {
		foot: `cost shares on the pricing shape in ${a.pricing.in}x / cacheW ${a.pricing.cacheC}x / cacheR ${a.pricing.cacheR}x / out ${a.pricing.out}x · requestId dedup: largest-output snapshot · searches normalized per request`,
		weekly: a.weekly.map((w) => ({
			d: new Date(w.week).toISOString().slice(0, 10),
			cost: Math.round(w.cost),
			cells: ACTIVITIES.map((k) => cell(k, w.shares[k])),
			orient: w.orientShare,
		})),
		lanes: a.actors.map((ar) => ({
			actor: ar.actor,
			cells: [cell("context", ar.contextShare)],
			orient: ar.orientShare,
			spr: ar.searchesPerReq.toFixed(2),
			cost: Math.round(ar.cost),
			req: ar.requests,
		})),
	};
};

// ─── W365 cross-hub slice: per-hub class sums + honest degrade rows ───────
const crossHubData = (x: CrossHubReport | undefined): UsageCrossHubPanel => {
	if (x === undefined || x.rows.length === 0)
		return {
			empty:
				"no hubs enumerated — stack.json hubs and hubs.json registry are both empty (or the route did not wire the rollup) on this board host",
		};
	const rows = x.rows.map((r) => {
		const segs: UsageSeg[] = [];
		for (const g of GROUPS) {
			const s = r.classes[g];
			if (s !== undefined) segs.push({ g, tok: s.tok });
		}
		for (const [g, s] of Object.entries(r.classes)) {
			if (!(GROUPS as string[]).includes(g)) segs.push({ g, tok: s.tok });
		}
		return {
			hub: r.label,
			via: r.via ?? "",
			spokes: r.spokes,
			segs,
			total: Object.values(r.classes).reduce((a, s) => a + s.tok, 0),
			rq: Object.values(r.classes).reduce((a, s) => a + s.requests, 0),
			degraded: !r.ok,
			reason: r.reason ?? undefined,
		};
	});
	const okN = x.summary.ok;
	const downN = x.summary.degraded + x.summary.unresolved;
	return {
		foot: `${String(okN)} reporting · ${String(downN)} down/unresolved · ${String(x.summary.hubs)} enumerated · ${String(x.days)}d window · TTL-cached per hub`,
		rows,
	};
};

// ─── page assembly ───────────────────────────────────────────────────────
export const usageHosts = `<klh-usage-header></klh-usage-header>
		<nav class="usage-jump" aria-label="Usage sections">
			<a href="#overview">Overview</a><a href="#monitor">Monitor</a><a href="#actors">Actors</a>
			<a href="#cache">Cache</a><a href="#sources">Sources</a>
			<a href="#activity">Activity</a>
		</nav>
		<section id="overview" class="usage-section" aria-label="Usage overview">
			<klh-usage-tiles></klh-usage-tiles><klh-usage-charts></klh-usage-charts><klh-usage-coverage></klh-usage-coverage>
		</section>
		<section id="monitor" class="usage-section" aria-label="Drilldown monitor">
			<klh-usage-monitor></klh-usage-monitor>
		</section>
		<section id="actors" class="usage-section" aria-label="Actor usage">
			<klh-usage-actors></klh-usage-actors><klh-usage-drilldown></klh-usage-drilldown>
		</section>
		<section id="cache" class="usage-section" aria-label="Cache efficiency">
			<klh-usage-cache-drill></klh-usage-cache-drill>
		</section>
		<section id="sources" class="usage-section" aria-label="Hub sources">
			<klh-usage-crosshub></klh-usage-crosshub>
		</section>
		<section id="activity" class="usage-section" aria-label="Activity and knowledge aids">
			<klh-usage-activity></klh-usage-activity><klh-usage-aids></klh-usage-aids>
		</section>`;

export function usagePayload(
	r: UsageReport,
	opts: {
		days: number;
		team?: string;
		dept?: string;
		includeDemo?: boolean;
		activity?: ActivityReport;
		crossHub?: CrossHubReport;
	},
): string {
	const team = opts.team ?? "";
	const dept = opts.dept ?? "";
	const includeDemo = opts.includeDemo ?? r.demo?.included ?? false;
	return chartPayload(
		r,
		headerData(r, r.days, team, dept, includeDemo),
		coverageData(r, { days: r.days, team, dept, includeDemo }),
		opts.activity,
		crossHubData(opts.crossHub),
	);
}

export function usagePage(
	r: UsageReport,
	opts: {
		days: number;
		team?: string;
		dept?: string;
		includeDemo?: boolean;
		activity?: ActivityReport;
		crossHub?: CrossHubReport;
	} = { days: r.days },
): string {
	return usagePageShell({
		title: "FLEET USAGE",
		body: usageHosts,
		payload: usagePayload(r, opts),
	});
}
