// W147: the SPA board wears the same console shell as every page. W658.2:
// the shell is the klh-topbar Lit component (avatar dropdown + settings
// gear; me fetched live from /api/console/me by the component); the fleet
// strip above it stays server-rendered theme.ts fleetNav().
import { FLEET_NAV_CSS, fleetNav, THEME_HEAD } from "../lib/theme.ts";
import { U_CSS, UPLOT_CSS, UPLOT_SRC } from "./usage-chrome.ts";

const unesc = (s) =>
	s
		.split("\\u2014")
		.join(String.fromCharCode(0x2014))
		.split("\\u00b7")
		.join(String.fromCharCode(0xb7))
		.split("\\u00B7")
		.join(String.fromCharCode(0xb7));

import { ACTIVITY } from "../board-html/activity.ts";
// fleet-board-html.ts — the fleet board page, split from the server so the
// HTML payload stays reviewable. Pure string; served by fleet-board.ts.
// Source stays pure ASCII: — renders an em dash, · a middle dot.
// v3: hash-tab shell (Decisions · Tasks · Activity · Governor · Setup),
// global project filter, decision history, task drawer, named lane states.
import { BODY } from "../board-html/body.ts";
import { BOOT } from "../board-html/boot.ts";
import { CORE } from "../board-html/core.ts";
import { DECISIONS } from "../board-html/decisions.ts";
import { DIFF } from "../board-html/diff.ts";
import { HISTORY } from "../board-html/history.ts";
import { ORCH } from "../board-html/orch.ts";
import { RENDERS } from "../board-html/renders.ts";
import { SETUP } from "../board-html/setup.ts";
import { SHIP } from "../board-html/ship.ts";
import { TABS } from "../board-html/tabs.ts";
import { TAIL } from "../board-html/tail.ts";
import { TASKS } from "../board-html/tasks.ts";
import { USAGE } from "../board-html/usage.ts";

// W157: the client JS lives in hooks/board-html/*.ts as String.raw chunk
// values interpolated into ONE outer String.raw — the same template
// semantics (and bun non-ASCII escaping) as the pre-split single file,
// so the served page is byte-identical. unesc distributes over the
// concatenation, so each chunk unesc's exactly as the original did.
// biome-ignore lint/complexity/noUselessStringRaw: byte-compat (W157)
export const HTML = unesc(String.raw`<!doctype html>
<html><head><meta charset="utf-8"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxMiIgZmlsbD0iI2ZmZiIvPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIzLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8cGF0aCBkPSJNMjIgMTAgQzIzIDQgNDEgNCA0MiAxMCIvPgogICAgPHBhdGggZD0iTTIyIDEwIEw0NCA0NSBMMzkgNTUiLz4KICAgIDxwYXRoIGQ9Ik00MiAxMCBMMjAgNDUgTDI1IDU1Ii8+CiAgICA8cGF0aCBkPSJNMzIgMjcgTDMyIDQ5Ii8+CiAgPC9nPgogIDxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMSIgc3Ryb2tlLXdpZHRoPSIyLjQiPgogICAgPGNpcmNsZSBjeD0iMzkiIGN5PSI1Ny4yIiByPSIyLjYiLz4KICAgIDxjaXJjbGUgY3g9IjI1IiBjeT0iNTcuMiIgcj0iMi42Ii8+CiAgICA8Y2lyY2xlIGN4PSIzMiIgY3k9IjUxLjYiIHI9IjIuNiIvPgogIDwvZz4KPC9zdmc+Cg=="><title>FLEET BOARD</title>
${THEME_HEAD}
<style>${FLEET_NAV_CSS}${U_CSS}${UPLOT_CSS}</style>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root, :root[data-theme="dark"] {
  --klh-ent-accent: #a08ed8;
  --klh-ent-accent-bg: #1d1a26;
  --klh-ent-accent-wash: rgba(160,142,216,.12);
  --klh-ent-edge: rgba(160,142,216,.38);
  --work-ready: #8cbbad;
  --work-working: #83ade0;
  --work-blocked: #e0ae62;
  --work-failed: #dc7865;
  --work-done: #a5c78a;
  --work-split: #b5a1e6;
  --work-cancelled: #a5a29a;
}
:root[data-theme="light"] {
  --klh-ent-accent: #6b5ca5;
  --klh-ent-accent-wash: rgba(107,92,165,.10);
  --klh-ent-edge: rgba(107,92,165,.35);
  --klh-ent-accent-bg: #efecf6;
  --work-ready: #276c5c;
  --work-working: #315f9a;
  --work-blocked: #8a570d;
  --work-failed: #a3361a;
  --work-done: #3f6a1c;
  --work-split: #654b9e;
  --work-cancelled: #55524b;
}
</style>
<script type="module" src="/vendor/klh-recovery.js"></script>
<style>
* { box-sizing: border-box; }
:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
[hidden] { display:none !important; }
body { background:var(--klh-bg); color:var(--klh-ink); font:13px/1.45 var(--klh-font-sans); margin:0; padding:16px 20px 28px; }
.mono { font-family:var(--klh-font-mono); }
.dim { color:var(--klh-dim); }
.state { font-size:12px; padding:4px 0; }
header { display:flex; align-items:center; gap:14px; margin-bottom:10px; }
header .mark { flex:none; white-space:nowrap; font-size:13px; font-weight:600; letter-spacing:.08em; }
header .right { margin-left:auto; display:flex; align-items:center; justify-content:flex-end; gap:10px; min-width:0; }
header #proj { width:min(220px, 19vw); flex:none; text-overflow:ellipsis; }
header #conn, header #stamp, header #blockedn { white-space:nowrap; }
#conn { font-size:11px; color:var(--klh-dim); }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:0; }
.dot.live { background:var(--klh-ok); }
.dot.stale { background:var(--klh-accent); }
.dot.err { background:var(--klh-danger); }
#stamp { font-size:11px; color:var(--klh-dim); font-variant-numeric:tabular-nums; }
#blockedn { color:var(--klh-danger-ink); font-size:11px; font-variant-numeric:tabular-nums; }
#needsn { background:var(--klh-danger-bg); border:1px solid var(--klh-danger); border-radius:2px; padding:2px 9px; color:var(--klh-danger-ink); font:inherit; font-size:11px; font-weight:600; cursor:pointer; }
#needsn:empty { display:none; }
.plabel { font-size:10px; color:var(--klh-dim); text-transform:uppercase; letter-spacing:.06em; }
select { background:var(--klh-surface); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font:11px var(--klh-font-mono); max-width:380px; }
@media (max-width:1100px) {
  header { flex-wrap:wrap; }
  header .right { margin-left:0; flex-wrap:wrap; justify-content:flex-start; width:100%; }
  header #proj { width:min(280px, 40vw); }
}
@media (max-width:700px) {
  body { padding:12px; }
  header .right { gap:8px; }
  header #proj { width:100%; }
  select { max-width:100%; min-width:0; }
}
#fleet { margin-bottom:14px; }
#fleetHead { display:block; width:100%; text-align:left; background:var(--klh-surface); border:1px solid var(--klh-edge); border-radius:2px; color:var(--klh-dim); padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
#fleetHead:hover { border-color:var(--klh-edge-strong); }
#fleetCaret { display:inline-block; width:10px; }
#fleetBody { display:none; padding:8px 2px 0; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.govrelay { display:flex; flex-wrap:wrap; align-items:center; gap:5px 16px; padding:9px 12px; border:1px solid var(--klh-edge); background:var(--klh-surface); font-size:11px; }
.govrelay strong { color:var(--klh-ink); font-size:11px; }
.govrelay .warn { color:var(--klh-danger-ink); max-width:min(36ch,100%); overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.govscope { margin:5px 0 12px; font-size:10px; line-height:1.4; }
#fleetHead { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 18px; min-height:44px; padding:8px 12px; }
.fleettitle { color:var(--klh-ink); font-weight:600; white-space:nowrap; }
.fleetmetrics { display:flex; flex-wrap:wrap; gap:8px 18px; color:var(--klh-dim); }
.fleetmetrics b { color:var(--klh-ink); font-variant-numeric:tabular-nums; font-weight:600; }
.fleetcontext { padding:6px 12px 0; font-size:10px; line-height:1.5; }
.chip { display:inline-block; border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font-size:10px; color:var(--klh-dim); margin:0 6px 6px 0; }
.chip b { color:var(--klh-ink); font-weight:500; }
.chip .st { text-transform:uppercase; letter-spacing:.06em; }
.chip.zombie { border-color:var(--klh-danger); color:var(--klh-danger-ink); }
.chip.zombie b { color:var(--klh-danger-ink); }
.fleetcolumns, .fleetrow { display:grid; grid-template-columns:minmax(140px, 1.5fr) minmax(110px, .7fr) minmax(90px, .6fr) minmax(100px, 1fr) minmax(120px, 1fr); gap:10px; align-items:center; min-width:700px; }
.fleetcolumns { color:var(--klh-dim); font-size:10px; text-transform:uppercase; letter-spacing:.06em; border-bottom:1px solid var(--klh-edge); padding:5px 8px; }
.fleetrow { border-bottom:1px solid var(--klh-edge-faint); padding:7px 8px; font-size:11px; }
.fleetrow b { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fleetrow span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fleetrow.zombie .fleetstate { color:var(--klh-danger-ink); }
.fleetmodel { font-family:var(--klh-font-mono); }
#fleetRecent, #fleetHistoryLanes { overflow-x:auto; }
.hfclear { background:none; border:none; color:var(--klh-accent); cursor:pointer; font:inherit; padding:0; text-decoration:underline; }
#decisions { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-panel); margin-bottom:14px; }
#decisions.has { border-color:var(--klh-danger-edge); }
#decisions h2 { margin:0; padding:8px 14px; display:flex; align-items:baseline; gap:12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-danger-ink); }
#decToggle { background:none; border:none; padding:0; color:inherit; font:inherit; letter-spacing:inherit; text-transform:inherit; cursor:pointer; }
#decCaret { display:inline-block; width:10px; }
#decState { margin-left:auto; color:var(--klh-dim); font-weight:400; text-transform:none; letter-spacing:0; font-size:12px; }
#decErr { padding:0 14px 8px; color:var(--klh-danger-ink); font-size:12px; }
#decErr:empty { display:none; }
#decisions.closed #decList, #decisions.closed #decErr { display:none; }
.dec { border-top:1px solid var(--klh-edge-faint); padding:10px 14px 12px; }
#decList .dec:first-child { border-top:none; }
.dec.sent { opacity:.55; }
.dhead { display:flex; gap:10px; align-items:baseline; font-size:11px; color:var(--klh-dim); flex-wrap:wrap; }
.dproj { color:var(--klh-accent); }
.dq { font-size:13.5px; line-height:1.4; margin:5px 0 2px; word-break:break-word; }
.dblocks { font-size:11px; color:var(--klh-dim); margin-bottom:4px; }
.dopts { margin:4px 0 2px; }
.optrow { display:flex; align-items:baseline; gap:8px; margin:4px 0; }
button.opt { background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge-strong); border-radius:2px; padding:2px 10px; font:inherit; font-size:11.5px; cursor:pointer; }
button.opt:hover { border-color:var(--klh-accent); color:var(--klh-accent); }
.optrow.sel button.opt { border-color:var(--klh-accent); color:var(--klh-accent); box-shadow:0 0 0 1px var(--klh-accent); background:var(--klh-accent-bg); }
.optrow .trade { font-size:10.5px; color:var(--klh-dim); }
.dadv { margin:7px 0 4px; padding:8px 10px; background:var(--klh-warm); border-left:2px solid var(--klh-accent); font-size:12px; }
.dadv .rhead { color:var(--klh-accent); font-weight:600; font-size:10px; letter-spacing:.06em; margin-bottom:2px; }
.dadv .why { color:var(--klh-dim); margin-top:3px; white-space:pre-wrap; }
.dadv .risk { color:var(--klh-danger-ink); margin-top:3px; }
.dadv .pconsensus { margin-top:4px; font-weight:600; font-size:11px; }
.dadv .pconsensus.pagree { color:var(--klh-ok-ink); }
.dadv .pconsensus.psplit { color:var(--klh-danger-ink); }
.dadv .pconsensus.pnone { color:var(--klh-dim); }
.dadv .pleg { color:var(--klh-dim); }
.dadv .plegerr { word-break:break-all; }
.dans { display:flex; gap:6px; margin-top:7px; flex-wrap:wrap; align-items:center; }
.dans input { flex:1; min-width:220px; background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:5px 9px; font:inherit; font-size:12px; }
.dans input:focus { outline:1px solid var(--klh-accent); }
button.send { background:var(--klh-accent); color:var(--klh-on-accent); border:1px solid var(--klh-accent); border-radius:2px; padding:5px 16px; font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.send:disabled, button.getrec:disabled { opacity:.45; cursor:default; }
button.getrec { background:var(--klh-bg); color:var(--klh-info); border:1px solid var(--klh-info); border-radius:2px; padding:5px 10px; font:inherit; font-size:11px; cursor:pointer; }
button.dismiss { background:none; border:none; padding:0; color:var(--klh-dim); font:inherit; font-size:10.5px; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.derr { color:var(--klh-danger-ink); font-size:11px; margin-top:5px; }
.derr:empty { display:none; }
.retry { background:none; border:1px solid var(--klh-danger); color:var(--klh-danger-ink); border-radius:2px; font:inherit; font-size:10px; padding:1px 8px; cursor:pointer; margin-left:8px; }
#hist { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-panel); }
.histhead { display:flex; align-items:baseline; gap:12px; padding:8px 14px; }
#histHead { background:none; border:none; padding:0; color:var(--klh-dim); font:inherit; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; cursor:pointer; }
#histHead:hover { color:var(--klh-ink); }
#histCaret { display:inline-block; width:10px; }
#histState { font-size:12px; color:var(--klh-dim); }
#histErr { padding:0 14px 8px; color:var(--klh-danger-ink); font-size:12px; }
#histErr:empty { display:none; }
#histBody { display:none; }
.hrow { border-top:1px solid var(--klh-edge-faint); padding:8px 14px 10px; font-size:12px; color:var(--klh-dim); display:flex; gap:10px; align-items:baseline; }
.hrow .hq { color:var(--klh-ink-3); word-break:break-word; }
.hans { display:block; margin-top:2px; }
.hage { margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
.pill.hst { flex:none; color:var(--klh-dim); border-color:var(--klh-edge-strong); font-size:9px; }
.pill.hst.open { color:var(--klh-danger-ink); border-color:var(--klh-danger); }
.taberr { color:var(--klh-danger-ink); font-size:12px; margin-bottom:10px; }
.taberr:empty { display:none; }
#tasksTbl { width:100%; border-collapse:collapse; font-size:12.5px; }
#tasksTbl th { text-align:left; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); border-bottom:1px solid var(--klh-edge); padding:6px 10px; }
#tasksTbl td { border-bottom:1px solid var(--klh-edge-faint); padding:7px 10px; vertical-align:top; }
#tasksTbl tr.taskkid td:first-child { padding-left:calc(10px + var(--indent, 12px)); border-left:2px solid var(--klh-edge-mid); }
#tasksTbl tr.taskkid { background:var(--klh-wash); }
#tasksTbl tbody tr:hover { background:var(--klh-surface); }
#tasksTbl th button.thsort { all:unset; cursor:pointer; font:inherit; color:inherit; text-transform:inherit; letter-spacing:inherit; }
#tasksTbl th button.thsort:hover { text-decoration:underline; text-underline-offset:3px; }
.kidmark { color:var(--klh-dim); margin-right:6px; }
.taskbar { display:flex; align-items:center; gap:10px; margin:0 0 10px; }
.taskbar .taskOrder { background:transparent; color:var(--klh-dim); border:1px solid var(--klh-edge-mid); border-radius:3px; padding:4px 8px; font:11px var(--klh-font-mono); cursor:pointer; }
.taskbar #taskDetails { margin-left:auto; }
.taskbar .taskOrder[aria-pressed="true"] { color:var(--klh-accent); border-color:var(--klh-accent); }
.taskbar .taskOrder:focus-visible, .taskFocus button:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
.taskFocus { display:flex; flex-wrap:wrap; gap:4px; border-bottom:1px solid var(--klh-edge); margin:0 0 8px; }
.taskFocus button { background:transparent; border:0; border-bottom:2px solid transparent; color:var(--klh-dim); cursor:pointer; padding:6px 10px; font:11px var(--klh-font-sans); }
.taskFocus button span { margin-left:5px; font:10px var(--klh-font-mono); font-variant-numeric:tabular-nums; }
.taskFocus button[aria-pressed="true"] { color:var(--klh-ink); border-bottom-color:var(--klh-accent); }
.taskFocus button[data-focus="attention"] span { color:var(--klh-danger-ink); }
.taskbar select {
  background:var(--klh-surface-hi); color:var(--klh-ink-2); border:1px solid var(--klh-edge); border-radius:4px;
  font:12px var(--klh-font-mono); padding:3px 6px;
}
.govsearch { margin-left:auto; color:var(--klh-dim); font-size:11px; white-space:nowrap; }
.govsearch input { width:220px; margin-left:5px; background:var(--klh-field); color:var(--klh-ink); border:1px solid var(--klh-edge-mid); border-radius:4px; padding:5px 8px; font:11px var(--klh-font-mono); }
.board-search { color:var(--klh-dim); font-size:11px; }
.board-search[hidden] { display:none; }
.board-search input { width:min(260px, 24vw); background:var(--klh-field); color:var(--klh-ink); border:1px solid var(--klh-edge-mid); border-radius:4px; font:12px var(--klh-font-mono); padding:5px 8px; }
.board-search input:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
#tasksTbl .num { text-align:right; font-variant-numeric:tabular-nums; color:var(--klh-dim); }
#tasksTbl .taskowner { max-width:145px; overflow-wrap:anywhere; }
#tab-tasks.taskcompact #tasksTbl .tail, #tab-tasks.taskcompact #tasksTbl .kwhen { display:none; }
#tab-tasks.taskcompact #tasksTbl td { padding-top:5px; padding-bottom:5px; }
/* W57 orchestrate box — LLM proposes a plan + parallel children from a goal; the human registers it as a plan-gated work split */
.orch { position:sticky; top:0; z-index:10; box-shadow:0 2px 8px var(--klh-shadow, rgba(0,0,0,.06)); border:1px solid var(--klh-edge); border-radius:4px; padding:0; margin:0 0 10px; background:var(--klh-wash); }
.orch summary { cursor:pointer; display:flex; align-items:center; gap:10px; padding:7px 12px; font-size:11px; font-weight:600; letter-spacing:.04em; list-style:none; }
.orch summary::-webkit-details-marker { display:none; }
.orch summary::before { content:'+'; color:var(--klh-accent); font:14px var(--klh-font-mono); }
.orch[open] summary::before { content:''; }
/* W875: minus control collapses the panel; visible only while expanded */
#orchCollapse { margin-left:auto; background:none; border:none; color:var(--klh-accent); font:14px var(--klh-font-mono); cursor:pointer; padding:0 2px; line-height:1; }
.orch:not([open]) #orchCollapse { display:none; }
.orch summary .dim { font-weight:400; letter-spacing:0; }
.orchbody { border-top:1px solid var(--klh-edge); padding:10px 12px; }
.orchcontext { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-bottom:9px; font-size:11px; }
.orchpill { border:1px solid var(--klh-accent); border-radius:3px; color:var(--klh-accent); padding:2px 7px; font:11px var(--klh-font-mono); }
.orchcontext select { font-size:11px; }
#orchDestination { font-family:var(--klh-font-mono); }
#orchClear { margin-left:auto; border:0; background:none; color:var(--klh-dim); cursor:pointer; font-size:16px; }
.korch { display:block; margin-top:4px; padding:2px 0; border:0; background:none; color:var(--klh-accent); cursor:pointer; font:10px var(--klh-font-mono); }
.korch:hover { text-decoration:underline; text-underline-offset:3px; }
.orchrow { display:flex; gap:8px; align-items:center; }
#orchGoal { flex:1; background:var(--klh-field); color:var(--klh-ink); border:1px solid var(--klh-edge-mid); border-radius:4px; font:12px var(--klh-font-mono); padding:5px 8px; resize:none; }
#orchGoal:focus { outline:none; border-color:var(--klh-accent); }
#orch.expanded .orchrow { align-items:flex-start; }
#orchSuggest { background:none; border:1px solid var(--klh-edge-strong); border-radius:4px; color:var(--klh-dim); font:inherit; font-size:11px; padding:4px 10px; cursor:pointer; }
#orchSuggest:disabled { opacity:.45; cursor:default; }
#orchSuggest:hover:not(:disabled) { color:var(--klh-ink); border-color:var(--klh-edge); }
#orchGo { background:none; border:1px solid var(--klh-accent); border-radius:4px; color:var(--klh-accent); font:inherit; font-size:11px; padding:4px 10px; cursor:pointer; }
#orchGo:disabled { opacity:.45; cursor:default; }
#orchGo:hover:not(:disabled) { background:var(--klh-accent-wash); }
/* W858.8 dropzone: dashed target + expiring ref list */
.orchdrop { margin-top:8px; display:flex; gap:8px; align-items:center; font-size:11px; }
#orchDrop { border:1px dashed var(--klh-edge-strong); border-radius:4px; padding:6px 10px; }
#orchDrop.drag { background:var(--klh-accent-wash); border-color:var(--klh-accent); }
#orchPick { background:none; border:1px solid var(--klh-edge-strong); border-radius:4px; color:var(--klh-dim); font:inherit; font-size:11px; padding:3px 8px; cursor:pointer; }
#orchPick:hover { color:var(--klh-ink); border-color:var(--klh-edge); }
.orchfile { font-size:11px; padding:2px 0; display:flex; gap:8px; align-items:baseline; }
.orchfname { font-weight:600; }
.orchfref { font:10px var(--klh-font-mono); word-break:break-all; color:var(--klh-accent); }
.orchfremove { background:none; border:none; color:var(--klh-danger-ink); cursor:pointer; font:inherit; font-size:10px; padding:0 4px; }
.orchplan { margin-top:8px; }
.orchtitle { font-size:12px; font-weight:600; }
.orchmeta { font-size:10px; margin:2px 0 6px; }
.orchkid { font-size:11px; padding:3px 0; border-top:1px solid var(--klh-edge-faint); }
.orchkidn { color:var(--klh-accent); margin-right:4px; }
.orchbrief { font-size:10px; margin-left:14px; }
.orchactions { margin-top:8px; display:flex; gap:8px; }
.orchdisc { background:none; border:1px solid var(--klh-edge-strong); border-radius:4px; color:var(--klh-dim); font:inherit; font-size:11px; padding:2px 8px; cursor:pointer; }
.orchdisc:hover { color:var(--klh-ink); }
.tidbtn { background:none; border:none; padding:0; color:var(--klh-accent); font:inherit; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
/* W65 lanes kanban — one column per work-graph state, cards carry the lane's live tail */
.kstatusnav { display:flex; gap:6px; overflow-x:auto; margin:0 0 8px; padding:0 0 4px; }
.kstatusnav button { flex:none; background:var(--klh-surface); border:1px solid var(--klh-edge); border-radius:3px; padding:4px 9px; color:var(--klh-ink-2); font:11px var(--klh-font-mono); cursor:pointer; }
.kstatusnav button:hover { border-color:var(--klh-accent); color:var(--klh-ink); }
.kstatusnav button:focus-visible { outline:2px solid var(--klh-accent); outline-offset:2px; }
.kstatusnav button[data-tone] { border-top:2px solid var(--state-color); color:var(--state-color); }
.kstatusnav button[data-tone="ready"], .kcol[data-tone="ready"], .kcard[data-tone="ready"] { --state-color:var(--work-ready); }
.kstatusnav button[data-tone="working"], .kcol[data-tone="working"], .kcard[data-tone="working"] { --state-color:var(--work-working); }
.kstatusnav button[data-tone="blocked"], .kcol[data-tone="blocked"], .kcard[data-tone="blocked"] { --state-color:var(--work-blocked); }
.kstatusnav button[data-tone="failed"], .kcol[data-tone="failed"], .kcard[data-tone="failed"] { --state-color:var(--work-failed); }
.kstatusnav button[data-tone="done"], .kcol[data-tone="done"], .kcard[data-tone="done"] { --state-color:var(--work-done); }
.kstatusnav button[data-tone="split"], .kcol[data-tone="split"], .kcard[data-tone="split"] { --state-color:var(--work-split); }
.kstatusnav button[data-tone="cancelled"], .kcol[data-tone="cancelled"], .kcard[data-tone="cancelled"] { --state-color:var(--work-cancelled); }
.kwrap { overflow-x:auto; }
.kanban { display:flex; gap:10px; align-items:flex-start; min-width:max-content; padding-bottom:8px; position:relative; }
.kcol { flex:0 0 250px; max-width:250px; border-top:2px solid var(--state-color, var(--klh-edge-mid)); padding-top:6px; }
.kcol h3 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); margin:0 0 8px; }
.kcount { float:right; font-variant-numeric:tabular-nums; }
/* The live project .prefer owns the card edge; status stays on the pill and column. */
.kcard { border:1px solid var(--prefer, var(--state-color, var(--klh-edge-soft))); border-radius:8px; padding:0 12px 10px; margin-bottom:8px; background:var(--klh-wash); cursor:pointer; }
.kcard:hover { border-color:var(--prefer, var(--state-color, var(--klh-edge-hover))); }
/* W890 ?w= deep link — the selected card (scrollIntoView + highlight) */
.kcard.ksel { border-color:var(--prefer, var(--state-color, var(--klh-accent))); box-shadow:0 0 0 2px var(--klh-accent-wash); }
.pdot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--prefer, transparent); margin-right:6px; vertical-align:1px; }
/* W819: shattered-family kids nest under the parent card — dashed border in the parent's --prefer color */
.kcard.kkid { border-style:dashed; position:relative; }
.kcard.kkid > .kidmark { position:absolute; left:-14px; top:12px; margin:0; }
/* W998.1: the badge is a corner tab — its outline sits ON the card's top and
   left border. The row's -13px left margin already reaches the card border's
   outer edge, so the pill takes margin-left:0 (its 1px border overlays the
   card's); margin-top:-1px climbs over the top border (card has no top
   padding). align-self:flex-start keeps row centering from pushing it off
   the top edge. Bottom-left stays square so the tab reads as part of the
   left border. */
.krow { display:flex; gap:6px; align-items:center; min-width:0; margin:0 -12px 0 -13px; min-height:23px; }
.krow .pill { position:relative; z-index:1; align-self:flex-start; margin:-1px 0 0 0; flex:none; border-radius:7px 0 3px 0; padding:3px 8px; background:var(--klh-wash); }
.kcard[data-tone] .krow .pill { color:var(--state-color); border-color:var(--state-color); }
.kcard[data-tone] .krow .pill .stl, .pill[data-tone] .stl { color:inherit; }
.kcardident { display:flex; gap:6px; align-items:baseline; min-width:0; margin-top:3px; }
.kcardident .tidbtn { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:12px; }
.kage { margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
.kcardstamp { margin-left:auto; padding-right:8px; font-size:8px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.kdec { flex:none; color:var(--klh-danger-ink); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
.ktitle { margin-top:7px; font-weight:600; line-height:1.32; word-break:break-word; }
.kmeta { display:flex; align-items:center; gap:6px; margin-top:5px; min-width:0; }
.klane { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:10px; }
.ktail { margin-top:4px; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--klh-dim); }
.kfailure { margin-top:6px; padding:4px 0 4px 8px; border-left:2px solid var(--klh-danger); color:var(--klh-ink); font-size:11px; line-height:1.4; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow-wrap:anywhere; }
.kstart { margin-top:6px; background:none; border:1px solid var(--klh-accent); border-radius:4px; color:var(--klh-accent); font:inherit; font-size:11px; padding:2px 8px; cursor:pointer; }
.kstart:hover { background:var(--klh-accent-wash); }
/* executor dropdown + play (board dispatch): one clean row — the select
   fills the card width, the play button hangs at its natural height inside
   the row (its old margin-top pushed it 3px low; W104) */
.kexec { margin-top:6px; display:flex; gap:6px; align-items:center; }
.kexec .kstart { margin-top:0; flex:none; }
.kexecsel { background:var(--klh-bg); border:1px solid var(--klh-accent); border-radius:4px; color:var(--klh-accent); font:inherit; font-size:11px; padding:2px 4px; max-width:250px; flex:1 1 auto; min-width:0; cursor:pointer; }
.kempty { font-size:11px; padding:2px 0 6px; }
.kwrap { position:relative; }
/* Model and origin are quiet card metadata. Danger red denotes failures only. */
.kmodel { display:inline-block; color:var(--klh-ink); font-size:10px; }
.kmeta .kmodel { flex:none; max-width:55%; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.lmodel { display:inline-block; border:1px solid var(--klh-danger); border-radius:2px; padding:0 6px; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--klh-danger-ink); }
.lmodel { margin-top:0; margin-left:6px; }
.lmodel.loc { border-color:var(--klh-ok); color:var(--klh-ok-ink); }
/* Hourly input-token bars; numbers sit beneath the chart. */
.kspend { display:flex; flex-direction:column; align-items:flex-start; gap:2px; margin-top:6px; }
.ksparkplot { width:180px; max-width:100%; }
.kspark { display:block; }
.kspark svg { display:block; max-width:100%; }
.kspark .spark-fresh { fill:var(--klh-accent); }
.kspark .spark-cached { fill:var(--klh-ok-ink); }
.kspark-tip { position:fixed; z-index:100; pointer-events:none; white-space:pre; padding:5px 7px; border:1px solid var(--klh-edge-strong); border-radius:3px; background:var(--klh-panel); color:var(--klh-ink); box-shadow:0 3px 12px #0003; font:9px/1.4 var(--klh-font-mono); font-variant-numeric:tabular-nums; }
.kspark-tip[hidden] { display:none; }
.ksparkaxis { display:none; justify-content:space-between; font-size:7px; line-height:1.2; }
.kspendtxt { display:block; font-size:7px; line-height:1.25; letter-spacing:.01em; }
.kspend-drawer .kspark { margin-top:6px; }
.kspend-drawer .ksparkplot { width:240px; }
.kspend-drawer .kspark svg { width:240px; height:36px; }
.ttitle { word-break:break-word; max-width:480px; }
.tail { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:480px; }
.akind { display:inline-block; border:1px solid var(--klh-edge-mid); border-radius:2px; padding:0 6px; font-size:9.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--klh-dim); }
.sec { margin-bottom:20px; }
.govpanel { margin-bottom:0; border-top:1px solid var(--klh-edge); padding:10px 0; }
.govpanel > summary { cursor:pointer; font-size:12px; font-weight:600; }
.govpanel > summary .dim { margin-left:8px; font-size:11px; font-weight:400; }
.govpanel > .feed { margin:10px 0 0; }
.sec h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); margin:0 0 8px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:10px; align-content:start; align-items:start; }
.setupsummary { margin:0 0 10px; font-size:11px; }
.sgroup { grid-column: 1 / -1; margin:8px 0 0; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); }
.sgroup .dim { font-weight:400; }
.sdetail summary { cursor:pointer; color:var(--klh-dim); }
.sdetail code { display:block; margin-top:6px; overflow-wrap:anywhere; font:11px var(--klh-font-mono); }
.card { background:var(--klh-surface); border:1px solid var(--klh-edge); border-radius:2px; padding:10px 12px; }
.pill { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.06em; background:transparent; border:1px solid; border-radius:2px; padding:1px 6px; margin-left:6px; vertical-align:1px; }
.pill.run { color:var(--klh-accent); border-color:var(--klh-accent); }
.pill.done { color:var(--klh-ok-ink); border-color:var(--klh-ok); }
.pill.block { color:var(--klh-danger-ink); border-color:var(--klh-danger); }
.pill.cancel { color:var(--klh-dim); border-color:var(--klh-edge-strong); text-decoration:line-through; }
.pill.ready { color:var(--klh-dim); border-color:var(--klh-edge-strong); }
.pill.waiting { color:var(--klh-accent); border-color:var(--klh-accent); }
.pill[data-tone="ready"] { color:var(--work-ready); border-color:var(--work-ready); }
.pill[data-tone="working"] { color:var(--work-working); border-color:var(--work-working); }
.pill[data-tone="blocked"] { color:var(--work-blocked); border-color:var(--work-blocked); }
.pill[data-tone="failed"] { color:var(--work-failed); border-color:var(--work-failed); }
.pill[data-tone="done"] { color:var(--work-done); border-color:var(--work-done); }
.pill[data-tone="split"] { color:var(--work-split); border-color:var(--work-split); }
.pill[data-tone="cancelled"] { color:var(--work-cancelled); border-color:var(--work-cancelled); }
/* W891 state letters — semantic state hues ride the klh tokens (F red, R blue, D green, Q gray) */
.stl { font-weight:700; letter-spacing:0; margin-right:5px; }
.stl.info { color:var(--klh-info); }
.stl.ok { color:var(--klh-ok-ink); }
.stl.danger { color:var(--klh-danger-ink); }
.stl.accent { color:var(--klh-accent); }
.stl.dim { color:var(--klh-dim); }
.rq { color:var(--klh-danger-ink); }
.scard .shead { display:flex; gap:8px; align-items:baseline; font-size:12.5px; }
.sok { flex:none; font-size:9px; text-transform:uppercase; letter-spacing:.08em; border:1px solid; border-radius:2px; padding:1px 6px; }
.sok.ok { color:var(--klh-ok-ink); border-color:var(--klh-ok); }
.sok.fail { color:var(--klh-danger-ink); border-color:var(--klh-danger); }
.sdetail { margin-top:5px; font-size:11.5px; word-break:break-word; }
.sfix { margin-top:7px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.sfix code { background:var(--klh-bg); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font-size:11px; color:var(--klh-ink); word-break:break-all; }
.copyfix { background:none; border:1px solid var(--klh-edge-strong); color:var(--klh-dim); border-radius:2px; font:inherit; font-size:10px; padding:2px 8px; cursor:pointer; }
.copyfix:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.feed { border:1px solid var(--klh-edge); border-radius:2px; padding:10px 12px; font-size:11.5px; margin-bottom:14px; }
.feed h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--klh-dim); margin:0 0 8px; }
.feed .filters { margin-bottom:6px; display:flex; gap:4px; flex-wrap:wrap; }
.feed .filters button { background:transparent; color:var(--klh-dim); border:1px solid var(--klh-edge); border-radius:2px; padding:1px 7px; font:9px var(--klh-font-mono); text-transform:uppercase; cursor:pointer; }
.feed .filters button.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.feed .r { display:flex; gap:8px; padding:2px 0; }
.failure-detail p { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.45; }
.failure-detail h3 { margin:10px 0 4px; font-size:10px; font-weight:600; color:var(--klh-dim); }
.feed .r .ts { width:52px; flex:none; text-align:right; color:var(--klh-dim); font-variant-numeric:tabular-nums; }
.feed .r.hot { border-left:2px solid var(--klh-danger); background:var(--klh-warm); padding-left:8px; }
.feed b { font-weight:500; }
.activityhead { margin-bottom:8px; color:var(--klh-dim); font-size:11px; }
.activityolder { margin-top:10px; border-top:1px solid var(--klh-edge); padding-top:8px; }
.activityolder summary { cursor:pointer; color:var(--klh-accent); font-size:11px; }
.activityolder[open] summary { margin-bottom:8px; }
.acthist { border:1px solid var(--klh-edge); border-radius:2px; padding:10px 12px 8px; margin-bottom:10px; font:10px var(--klh-font-mono); color:var(--klh-dim); }
.acthist:empty { display:none; }
.acthist-head, .acthist-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.acthist-head { margin-bottom:7px; text-transform:uppercase; letter-spacing:.06em; }
.acthist-foot { margin-top:5px; font-size:9px; }
.acthist-bars { display:grid; grid-template-columns:repeat(24,minmax(0,1fr)); align-items:end; gap:2px; height:44px; }
.acthist-bar { position:relative; display:flex; align-items:end; justify-content:center; height:100%; min-width:0; padding:0; border:0; border-bottom:1px solid var(--klh-edge); background:transparent; cursor:pointer; }
.acthist-bar:hover, .acthist-bar:focus-visible, .acthist-bar.selected { background:var(--klh-warm); outline:1px solid var(--klh-accent); outline-offset:0; }
.acthist-stack { display:flex; flex-direction:column; width:100%; min-height:2px; overflow:hidden; }
.acthist-stack > span { display:block; min-height:1px; }
.acthist-landed { background:var(--klh-ok); }
.acthist-failed { background:var(--klh-danger); }
.acthist-decision { background:var(--klh-accent); }
.acthist-other { background:var(--klh-edge-mid); }
.acthist-key { display:flex; align-items:center; gap:4px; white-space:nowrap; }
.acthist-key i { display:inline-block; width:6px; height:6px; margin-left:5px; }
.acthist-tip { display:none; position:absolute; bottom:calc(100% + 4px); left:50%; transform:translateX(-50%); z-index:30; min-width:130px; max-width:240px; padding:6px 8px; border:1px solid var(--klh-edge-mid); border-radius:2px; background:var(--klh-surface); color:var(--klh-ink); font-size:9px; line-height:1.6; text-align:left; white-space:nowrap; pointer-events:none; box-shadow:0 2px 8px rgba(0,0,0,.35); }
.acthist-bar:hover .acthist-tip, .acthist-bar:focus-visible .acthist-tip, .acthist-bar.selected .acthist-tip { display:block; }
.acthist-bar:first-child .acthist-tip { left:0; transform:none; }
.acthist-bar:last-child .acthist-tip { left:auto; right:0; transform:none; }
@media (max-width:640px) { .acthist-key { font-size:0; gap:1px; } .acthist-key i { width:7px; height:7px; margin-left:2px; } }
#drawer { position:fixed; top:0; right:0; bottom:0; width:min(420px, 92vw); background:var(--klh-overlay); border-left:1px solid var(--klh-edge-mid); box-shadow:-8px 0 24px var(--klh-shadow); padding:14px 16px 20px; overflow-y:auto; z-index:70; }
.dwhead { display:flex; align-items:baseline; gap:10px; margin-bottom:8px; }
.drawerAction { margin:8px 0 12px; }
.drawerAction:last-child { margin-bottom:0; }
.drawerAction > label { display:block; margin-bottom:5px; color:var(--klh-dim); font-size:11px; }
.drawerActionControls { display:flex; align-items:stretch; gap:8px; }
.drawerActionControls > input, .drawerActionControls > select { flex:1; min-width:0; width:0; }
.drawerActionControls > button { flex:none; white-space:nowrap; }
@media (max-width:480px) { .drawerActionControls { flex-wrap:wrap; } .drawerActionControls > input, .drawerActionControls > select { width:100%; flex-basis:100%; } }
#drawerTitle { margin:0; font-size:13px; font-weight:600; word-break:break-word; }
#drawerClose { background:none; border:1px solid var(--klh-edge-strong); border-radius:2px; color:var(--klh-dim); font-size:14px; line-height:1; padding:3px 9px; cursor:pointer; margin-left:auto; }
#drawerClose:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.dd { padding:4px 0; border-bottom:1px solid var(--klh-edge-faint); font-size:12px; }
.dd:last-child { border-bottom:none; }
#taskDiff { margin-top:10px; }
.diffbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.diffbtn { background:none; border:1px solid var(--klh-edge-strong); color:var(--klh-dim); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.diffbtn:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.diffbtn.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.diffcap { font-size:10.5px; color:var(--klh-dim); word-break:break-all; }
.diffmsg { font-size:11px; color:var(--klh-ok-ink); }
.diffmsg.risk { color:var(--klh-danger-ink); }
.diffwrap { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-bg); }
.diffview { margin:0; padding:6px 0; font-size:10.5px; line-height:1.5; max-height:340px; overflow:auto; display:block; }
.dline { display:block; white-space:pre; padding:0 8px; }
.dline.add { background:var(--klh-ok-wash); color:var(--klh-ok-hi); }
.dline.del { background:var(--klh-danger-wash); color:var(--klh-danger-ink); }
.dline.hunk { color:var(--klh-info); }
.dline.meta { color:var(--klh-dim); }
.dlnum { display:inline-block; width:34px; text-align:right; padding-right:6px; color:var(--klh-dim); cursor:pointer; }
.dlnum:hover { color:var(--klh-accent); }
.dnote { display:flex; gap:6px; margin-top:6px; align-items:center; }
.dnote .dtgt { font-size:10.5px; color:var(--klh-accent); word-break:break-all; }
.dnote input { flex:1; min-width:140px; background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font:inherit; font-size:11px; }
.dnote input:focus { outline:1px solid var(--klh-accent); }
button.diffsend { background:var(--klh-accent); color:var(--klh-on-accent); border:1px solid var(--klh-accent); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.diffsend:disabled { opacity:.45; cursor:default; }
#taskTail { margin-top:10px; }
.tailbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
.tailbtn { background:none; border:1px solid var(--klh-edge-strong); color:var(--klh-dim); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
.tailbtn:hover { color:var(--klh-ink); border-color:var(--klh-edge-hover); }
.tailbtn.on { color:var(--klh-accent); border-color:var(--klh-accent); }
.tailcap { font-size:10.5px; color:var(--klh-dim); word-break:break-all; }
.tailwrap { border:1px solid var(--klh-edge); border-radius:2px; background:var(--klh-bg); }
.tailview { margin:0; padding:6px 0; font-size:10.5px; line-height:1.5; max-height:340px; overflow:auto; display:block; white-space:pre-wrap; word-break:break-word; }
.tailview .trow { display:block; padding:0 8px; }
.tailmsg { font-size:11px; color:var(--klh-ok-ink); }
.tailmsg.risk { color:var(--klh-danger-ink); }
.lanemsg { flex:1; min-width:140px; background:var(--klh-bg); color:var(--klh-ink); border:1px solid var(--klh-edge); border-radius:2px; padding:3px 8px; font:inherit; font-size:11px; }
.lanemsg:focus { outline:1px solid var(--klh-accent); }
button.lanesend { background:var(--klh-accent); color:var(--klh-on-accent); border:1px solid var(--klh-accent); border-radius:2px; padding:3px 10px; font:inherit; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; cursor:pointer; }
button.lanesend:disabled { opacity:.45; cursor:default; }
#toasts { position:fixed; bottom:16px; right:16px; display:flex; flex-direction:column; gap:6px; z-index:40; max-width:min(380px, 90vw); }
.toast { background:var(--klh-warm); border:1px solid var(--klh-danger); border-left-width:3px; color:var(--klh-ink); padding:8px 12px; font-size:12px; border-radius:2px; box-shadow:0 2px 12px var(--klh-shadow); }
</style></head><body>
${fleetNav("suspenders", "suspenders")}
<klh-topbar><a slot="settings-extra" href="/console/settings">all console settings &rarr;</a></klh-topbar>
<script>/*SETUP_SEED*/</script>
${BODY}${CORE}${RENDERS}${DECISIONS}${HISTORY}${TASKS}${DIFF}${SHIP}${TAIL}${ACTIVITY}${SETUP}${USAGE}${TABS}${ORCH}${BOOT}</script>
<script>${UPLOT_SRC}</script>
<script type="module" src="/vendor/klh-components.js"></script>
<script type="module" src="/vendor/klh-topbar.js"></script>
<script type="module" src="/vendor/klh-board-tabs.js"></script>
<script type="module" src="/vendor/usage-panels.js"></script>
<script type="module" src="/vendor/klh-ent-zone.js"></script>`);
