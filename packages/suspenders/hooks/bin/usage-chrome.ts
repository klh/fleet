// hooks/bin/usage-chrome.ts — the ONE usage-dashboard chrome (W652.3): the
// stat-tile row, model-group palette, legend, uPlot vendor inlines, and page
// shell shared by the local /usage page and the hub federation page. One
// source stops the per-page chrome drift the W171 copy had begun.
// Server-rendered on the W152 dataviz discipline (fixed group order, color
// follows the entity, validated dark palette); component-ization per the UI
// law rides the W184 staged Lit migration.
import { readFileSync } from "node:fs";
import { GROUPS } from "../lib/usage.ts";
import { USAGE_CHART_JS } from "./usage-charts.ts";
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

// stat-tile row: the label/value cells both dashboards open with
export const tilesRow = (cells: [string, string][]): string =>
	`<div class="utiles">${cells
		.map(
			([k, v]) =>
				`<div class="utile"><div class="uv">${v}</div><div class="uk">${k}</div></div>`,
		)
		.join("")}</div>`;

export function legendHtml(): string {
	const items = GROUPS.map(
		(g) => `<span><i style="background:${SLOT[g]}"></i>${g}</span>`,
	);
	return `<div class="ulegend">${items.join("")}</div>`;
}

// the full W152 u* chrome — the superset of both dashboards' local copies;
// extra classes are inert where a page doesn't render those elements
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
.ufgroup { display:flex; gap:6px; align-items:center; }
.ufgroup::before { content:attr(data-label); font-size:9.5px; color:var(--klh-dim); text-transform:uppercase; letter-spacing:.06em; }
.ufilter, .ufchip { font-size:11px; color:var(--klh-dim); text-decoration:none; border:1px solid var(--klh-edge); border-radius:2px; padding:2px 9px; }
.ufilter.on, .ufchip.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.uon { font-size:10.5px; color:var(--klh-accent); }
table.uacts { width:100%; border-collapse:collapse; font-size:12px; }
table.uacts td, table.uacts th { padding:6px 8px; border-bottom:1px solid var(--klh-rule); text-align:left; }
.unum { text-align:right; font-variant-numeric:tabular-nums; color:var(--klh-ink-2); white-space:nowrap; }
.ubar { display:flex; height:12px; border-radius:3px; overflow:hidden; min-width:2px; }
.ubar i { display:block; height:100%; }
.udot { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:6px; }
.uchip { font-size:10px; color:var(--klh-dim); border:1px solid var(--klh-edge); border-radius:2px; padding:1px 6px; margin-left:6px; }
tr.udetail td { padding-top:0; border-bottom:none; }
tr.udetail details { font-size:11px; color:var(--klh-dim); }
tr.udetail summary { cursor:pointer; }
table.umtab { margin:6px 0 10px; border-collapse:collapse; }
table.umtab td, table.umtab th { padding:2px 10px 2px 0; font-size:11px; text-align:left; color:var(--klh-ink-2); }
.uempty { color:var(--klh-dim); font-size:12px; }
.ufoot { font-size:10.5px; color:var(--klh-dim); margin:2px 0 8px; }
.uchart { width:100%; }
/* uPlot chrome on the board dark palette: recessive grid + muted axis ink
   are also set per-axis in usage-charts.ts; these style the live legend */
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
	const scripts = `<style>${UPLOT_CSS}</style><script type="application/json" id="usage-data">${cfg.payload}</script><script>${USAGE_CHART_JS}</script>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${cfg.title}</title>${THEME_HEAD}<style>body{background:var(--klh-bg);color:var(--klh-ink);font:13px/1.45 var(--klh-font-sans);margin:0;padding:0 20px 28px;}a{color:var(--klh-accent)}.utitle{font-size:14px;letter-spacing:.08em;margin:14px 0 10px;color:var(--klh-ink)}${U_CSS}${FLEET_NAV_CSS}</style></head><body>${fleetNav("suspenders", "suspenders")}<klh-topbar></klh-topbar><main style="max-width:1060px;margin:0 auto">${cfg.body}</main><script>${UPLOT_SRC}</script>${scripts}<script type="module" src="/vendor/klh-topbar.js"></script></body></html>`;
}
