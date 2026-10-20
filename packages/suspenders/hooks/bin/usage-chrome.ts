// hooks/bin/usage-chrome.ts — the ONE usage-dashboard chrome (W652.3): the
// stat-tile row, model-group palette, legend, uPlot vendor inlines, and page
// shell shared by the local /usage page and the hub federation page. One
// source stops the per-page chrome drift the W171 copy had begun.
// Server-rendered on the W152 dataviz discipline (fixed group order, color
// follows the entity, validated dark palette); component-ization per the UI
// law rides the W184 staged Lit migration.
import { readFileSync } from "node:fs";
import { THEME_HEAD, FLEET_NAV_CSS, fleetNav } from "../lib/theme.ts";

// uPlot 1.6.32 (MIT, © Leon Sorokin, https://github.com/leeoniya/uPlot) —
// vendored single file, license header preserved at the top of the source.
// Read at render time relative to this module; inlined per page load.
const UPLOT_SRC = readFileSync(
	new URL("./vendor/uPlot.iife.min.js", import.meta.url),
	"utf8",
);
const UPLOT_CSS = readFileSync(
	new URL("./vendor/uPlot.min.css", import.meta.url),
	"utf8",
);

// validated dark categorical slots, fixed order = GROUPS (never cycled —
// color follows the entity: flash is always blue, full always orange, …)
export const SLOT: Record<string, string> = {
	flash: "#3987e5",
	full: "#d95926",
	luna: "#199e70",
	local: "#c98500",
	other: "#d55181",
};

export const esc = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

export const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));

// ─── W652.3.1 panel payload slices (W184 staged Lit migration) ────────────
// The emitters stopped string-building panel interiors per request: they
// shape display-ready slices into the #usage-data payload's `panels` key and
// emit static <klh-usage-*> hosts; board-html/usage-panels.ts renders them
// client-side. Interfaces here (the seam, server-side, no lit import) are
// the one contract both sides read.
export interface UsageTile {
	k: string;
	v: string;
}
export interface UsageSeg {
	g: string;
	tok: number;
}
export interface UsageActorRow {
	actor: string;
	demo: boolean;
	chips: string[];
	barW: number;
	segs: UsageSeg[];
	models: { m: string; g: string; tok: number; rq: number }[];
	total: number;
	rq: number;
}
export interface UsageActorsPanel {
	rows: UsageActorRow[];
}
export interface UsageAidsPanel {
	title: string;
	foot?: string;
	empty?: string;
	rows: {
		aid: string;
		domain: string;
		inj: number;
		skip: number;
		tok: number;
	}[];
}
export interface UsageActivityCell {
	key: string;
	share: number;
}
export interface UsageActivityWeek {
	d: string;
	cost: number;
	cells: UsageActivityCell[];
	orient: number;
}
export interface UsageActivityLane {
	actor: string;
	cells: UsageActivityCell[];
	orient: number;
	spr: string;
	cost: number;
	req: number;
}
export interface UsageActivityPanel {
	foot: string;
	weekly: UsageActivityWeek[];
	lanes: UsageActivityLane[];
}
export interface UsageSpokesPanel {
	rows: {
		spoke: string;
		team: string;
		barW: number;
		segs: UsageSeg[];
		total: number;
		rq: number;
	}[];
}
// W365: the cross-hub rollup slice — one row per hub (ok rows carry sums,
// degraded/unresolved rows carry the honest reason). Via/url stay server-
// side; the browser sees labels + sums only.
export interface UsageCrossHubRow {
	hub: string;
	via: string;
	spokes: number;
	segs: UsageSeg[];
	total: number;
	rq: number;
	degraded: boolean;
	reason?: string;
}
export interface UsageCrossHubPanel {
	foot?: string;
	empty?: string;
	rows: UsageCrossHubRow[];
}
// W695.3.4: the page header (back bar + title + filter chips) as a slice —
// hrefs are computed server-side (the query string IS the view state), the
// <klh-usage-header> component only lays them out.
export interface UsageChip {
	label: string;
	href: string;
	on: boolean;
}
export interface UsageHeaderPanel {
	back: string;
	windows: UsageChip[];
	teams: UsageChip[];
	depts: UsageChip[];
	filtered?: string;
	status: string;
}
// W858.11: the evidence slice — what the window actually covers, how fresh
// the newest bucket is, where the gaps are, and the per-day drilldown (each
// day links its first live hour into the HOUR DETAIL drilldown).
export interface UsageCoverageDay {
	d: string;
	hoursData: number;
	tok: number;
	/** server-built drilldown href (first live hour of the day → #usage-hour) */
	href?: string;
}
export interface UsageCoveragePanel {
	from: string;
	to: string;
	hoursTotal: number;
	hoursData: number;
	newest: string;
	newestAgeH: number;
	longestGapH: number;
	gapEnd: string;
	source: "verified transcript usage" | "legacy aggregate usage";
	demoNote?: string;
	byDay: UsageCoverageDay[];
}
export interface UsagePanels {
	header?: UsageHeaderPanel;
	tiles?: UsageTile[];
	actors?: UsageActorsPanel;
	aids?: UsageAidsPanel;
	activity?: UsageActivityPanel | { empty: string };
	spokes?: UsageSpokesPanel;
	crosshub?: UsageCrossHubPanel;
	coverage?: UsageCoveragePanel;
}

// the light-DOM u* chrome the two dashboards still render server-side or in
// <klh-usage-charts> — the W652.3.1 Lit panels carry shadow-scoped copies of
// everything else (tiles/tables/bars/chips)
const U_CSS = `
.uback { display:flex; gap:16px; align-items:baseline; margin:12px 0 0; }
.uwin { font-size:10.5px; color:var(--klh-dim); }
.upanel { background:var(--klh-surface); border:1px solid var(--klh-edge-soft); border-radius:3px; padding:12px 14px 10px; margin-bottom:14px; }
.upanel h2 { margin:0 0 6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); }
.upanel .uhead { display:flex; align-items:baseline; gap:12px; }
.upanel .uhead .ufoot { margin:0; }
.ulegend { display:flex; gap:14px; font-size:11px; color:var(--klh-ink-2); margin:0 0 8px; flex-wrap:wrap; }
.ulegend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
.ufilters { display:flex; gap:18px; align-items:center; margin:0 0 14px; flex-wrap:wrap; }
.ufgroup { display:flex; gap:6px; align-items:center; }
.ufgroup::before { content:attr(data-label); font-size:9.5px; color:var(--klh-dim); text-transform:uppercase; letter-spacing:.06em; }
.ufilter, .ufchip { font-size:11px; color:var(--klh-dim); text-decoration:none; border:1px solid var(--klh-edge); border-radius:2px; padding:2px 9px; }
.ufilter.on, .ufchip.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.uon { font-size:10.5px; color:var(--klh-accent); }
.ufoot { font-size:10.5px; color:var(--klh-dim); margin:2px 0 8px; }
.uchart { width:100%; }
.usage-jump { display:flex; gap:4px; flex-wrap:wrap; position:sticky; top:0; z-index:2; margin:0 0 16px; padding:7px 0; background:var(--klh-bg); border-bottom:1px solid var(--klh-edge); }
.usage-jump a { padding:5px 10px; color:var(--klh-ink-2); text-decoration:none; font-size:11px; border-radius:2px; }
.usage-jump a:hover, .usage-jump a:focus-visible { color:var(--klh-accent); background:var(--klh-surface); outline-color:var(--klh-accent); }
.usage-section { scroll-margin-top:58px; }
.usage-section + .usage-section { margin-top:22px; padding-top:18px; border-top:1px solid var(--klh-edge); }
.usage-chart-grid { display:grid; grid-template-columns:minmax(0,2fr) minmax(290px,1fr); gap:14px; }
.usage-chart-grid .upanel { min-width:0; }
@media (max-width:850px) { .usage-chart-grid { grid-template-columns:minmax(0,1fr); } .usage-jump { position:static; } }
/* uPlot chrome on the board dark palette: recessive grid + muted axis ink
   are also set per-axis in the charts component; these style the live legend */
.uplot .u-legend { font: 10.5px/1.7 var(--klh-font-mono); color:var(--klh-ink-2); text-transform:uppercase; letter-spacing:.04em; }
.uplot .u-legend .u-value { font-variant-numeric:tabular-nums; color:var(--klh-ink); }
.uplot .u-legend .u-series.u-off { opacity:.4; }
.uplot .u-marker { width:9px; height:9px; border-radius:2px; }
.uplot text { font-size:10px; }
`;

// page shell: doctype + theme + the u* chrome + topbar + centered main +
// the vendor script block — byte-identical structure on both dashboards
export function usagePageShell(cfg: {
	title: string;
	body: string;
	payload: string;
}): string {
	// "<" → <: equivalent JSON, but a payload string can never close the
	// script block (W695.3.5: the degraded reason now rides the payload)
	const safePayload = cfg.payload.replace(/</g, "\\u003c");
	const scripts = `<style>${UPLOT_CSS}</style><script type="application/json" id="usage-data">${safePayload}</script><script type="module" src="/vendor/klh-topbar.js"></script><script type="module" src="/vendor/usage-panels.js"></script>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${cfg.title}</title>${THEME_HEAD}<style>body{background:var(--klh-bg);color:var(--klh-ink);font:13px/1.45 var(--klh-font-sans);margin:0;padding:0 20px 28px;}a{color:var(--klh-accent)}.utitle{font-size:14px;letter-spacing:.08em;margin:14px 0 10px;color:var(--klh-ink)}${U_CSS}${FLEET_NAV_CSS}</style></head><body>${fleetNav("suspenders", "usage")}<klh-topbar></klh-topbar><main style="max-width:1260px;margin:0 auto">${cfg.body}</main><script>${UPLOT_SRC}</script>${scripts}</body></html>`;
}
