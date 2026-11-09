// hooks/bin/federation-work-html.ts — W370 the federated work view page:
// LOCAL scope first (this machine's open work), then one scope per
// declared edge — "the work THEY are responsible for". Server-rendered
// from a completed view (the route pulls; the page only renders), honest
// about degraded edges (reason + last-known counts). No client interactive
// JS beyond the shared kernel theme pre-paint (THEME_HEAD, every klh page
// carries it) — the hub picker is a plain GET form, no onchange handler.
// W2878: hub dropdown (select from the declared peers, default=all), the
// runner-session placeholder column (W2869 seam — never fabricated), and
// the viewer gate (admin sees every lane; a self-asserted ?viewer=<sid>
// narrows to that owner's lanes; anonymous = the pre-W2878 unfiltered page,
// unchanged).
import { THEME_HEAD } from "@klh/kernel/src/kernel.theme.module.ts";
import type {
	FedWorkRow,
	FedWorkView,
	WorkFeedItem,
} from "../lib/federation/federation-work.ts";

const esc = (s: string): string =>
	s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const TABLE_HEAD =
	"<thead><tr><th>id</th><th>state</th><th>title</th><th>runner</th></tr></thead>";

function itemRows(items: WorkFeedItem[]): string {
	return items
		.map(
			(it) =>
				`<tr><td class="id">${esc(it.id)}</td><td><span class="st st-${esc(it.state.toLowerCase())}">${esc(it.state)}</span></td><td>${esc(it.title)}</td><td class="runner">${esc(it.runner_state ?? "—")}</td></tr>`,
		)
		.join("\n");
}

function edgeSection(p: FedWorkRow): string {
	const when = p.pulled_at ?? "never";
	if (p.feed === null)
		return `<section class="scope"><h2>${esc(p.label)} — their work</h2>
<p class="degraded">degraded: ${esc(p.reason ?? "unknown")} (never pulled)</p></section>`;
	const badge = p.ok
		? '<span class="badge live">live</span>'
		: `<span class="badge deg">degraded — last-known (${esc(p.reason ?? "unknown")})</span>`;
	return `<section class="scope">
<h2>${esc(p.label)} — their work ${badge}</h2>
<p class="meta">via ${esc(p.via ?? "?")} · ${esc(p.url ?? "?")} · pulled ${esc(when)} · open=${String(p.feed.total)}${p.feed.trunc ? ` (showing ${String(p.feed.items.length)}, capped)` : ""}</p>
<table>${TABLE_HEAD}
<tbody>
${itemRows(p.feed.items)}
</tbody></table></section>`;
}

const pageCss =
	(): string => `body { font: var(--klh-text-lg)/1.5 var(--klh-font-sans); margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: var(--klh-ink); background: var(--klh-bg); }
h1 { font-size: var(--klh-text-xl); }
h2 { font-size: var(--klh-text-lg); margin-bottom: var(--klh-space-2); }
.meta { color: var(--klh-dim); font-size: var(--klh-text-sm); margin-top: 0; }
.viewer { color: var(--klh-accent); font-size: var(--klh-text-sm); font-weight: 600; }
.degraded { color: var(--klh-danger-ink); font-size: var(--klh-text-sm); }
.badge { font-size: var(--klh-text-xs); padding: 0.1rem 0.45rem; border-radius: var(--klh-radius-lg); vertical-align: middle; }
.badge.live { background: var(--klh-ok-bg); color: var(--klh-ok-ink); }
.badge.deg { background: var(--klh-danger-bg); color: var(--klh-danger-ink); }
table { border-collapse: collapse; width: 100%; font-size: var(--klh-text-md); }
th, td { text-align: left; padding: var(--klh-space-2) var(--klh-space-4); border-bottom: 1px solid var(--klh-edge-faint); }
th { color: var(--klh-dim); font-weight: 500; }
td.id { color: var(--klh-dim); white-space: nowrap; }
td.runner { color: var(--klh-ink-3); }
.st { font-size: var(--klh-text-xs); padding: 0.08rem 0.4rem; border-radius: var(--klh-radius-lg); background: var(--klh-surface-hi); }
.st-ready { background: var(--klh-ok-bg); }
.st-claimed, .st-running { background: var(--klh-accent-bg); }
.st-blocked, .st-failed { background: var(--klh-danger-bg); }
section.scope { margin-top: var(--klh-space-7); }
.hubpick { display: flex; align-items: center; gap: var(--klh-space-3); margin: var(--klh-space-4) 0; font-size: var(--klh-text-sm); }
.hubpick select { background: var(--klh-field); color: var(--klh-ink); border: 1px solid var(--klh-edge); border-radius: var(--klh-radius); padding: var(--klh-space-1) var(--klh-space-2); }
.hubpick button { background: var(--klh-accent); color: var(--klh-on-accent); border: none; border-radius: var(--klh-radius); padding: var(--klh-space-1) var(--klh-space-3); cursor: pointer; }
footer { margin-top: var(--klh-space-7); color: var(--klh-dim); font-size: var(--klh-text-xs); }`;

function localSection(v: FedWorkView): string {
	return `<section class="scope">
<h2>LOCAL — ${esc(v.local.hub)}</h2>
<p class="meta">open=${String(v.local.total)}${v.local.trunc ? ` (showing ${String(v.local.items.length)}, capped)` : ""} · generated ${esc(v.local.generated_at)}</p>
<table>${TABLE_HEAD}
<tbody>
${itemRows(v.local.items)}
</tbody></table></section>`;
}

const footerHtml = (v: FedWorkView): string =>
	`<footer>W370 federated work view · me=${esc(v.me)} · edges light up with HUB_PEERS (or stack.json hubs.&lt;me&gt;.peers) + SUSPENDERS_FEDERATION_WORK_TOKEN · runner column is the W2869 seam (placeholder until runner.* events land)</footer>`;

export interface FederationWorkPageOpts {
	/** Selected hub label, or null/"all" for every section (default). */
	hub?: string | null;
	/** Self-asserted viewer sid (?viewer=<sid>) — echoed back into the hub
	 *  picker form so re-filtering by hub keeps the originator narrowing. */
	viewerSid?: string | null;
	/** Admin viewers always see every lane — the caller already applied (or
	 *  skipped) the owner filter before building this page. */
	admin?: boolean;
}

function viewerBanner(opts: FederationWorkPageOpts): string {
	if (opts.admin) return '<p class="viewer">admin view — every lane</p>';
	if (opts.viewerSid)
		return `<p class="viewer">originator view — lanes owned by ${esc(opts.viewerSid)}</p>`;
	return "";
}

function hubPicker(v: FedWorkView, opts: FederationWorkPageOpts): string {
	const current = opts.hub && opts.hub !== "all" ? opts.hub : "all";
	const sel = (label: string): string => (current === label ? " selected" : "");
	const options = [
		`<option value="all"${sel("all")}>all hubs</option>`,
		`<option value="${esc(v.local.hub)}"${sel(v.local.hub)}>LOCAL — ${esc(v.local.hub)}</option>`,
		...v.peers.map(
			(p) =>
				`<option value="${esc(p.label)}"${sel(p.label)}>${esc(p.label)}</option>`,
		),
	].join("");
	const viewerHidden = opts.viewerSid
		? `<input type="hidden" name="viewer" value="${esc(opts.viewerSid)}">`
		: "";
	return `<form method="GET" class="hubpick"><label for="hubsel">hub</label><select id="hubsel" name="hub">${options}</select>${viewerHidden}<button type="submit">filter</button></form>`;
}

export function federationWorkPage(
	v: FedWorkView,
	opts: FederationWorkPageOpts = {},
): string {
	const hub = opts.hub && opts.hub !== "all" ? opts.hub : null;
	const showLocal = hub === null || hub === v.local.hub;
	const shownPeers =
		hub === null ? v.peers : v.peers.filter((p) => p.label === hub);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>federated work — ${esc(v.me)}</title>
${THEME_HEAD}
<style>
${pageCss()}
</style>
</head>
<body>
<h1>Federated work — me=${esc(v.me)}</h1>
<p class="meta">generated ${esc(v.generated_at)} · each section is one hub's OWN open work (hub→spoke boundary: a spoke's items never travel via another hub's feed)</p>
${viewerBanner(opts)}
${hubPicker(v, opts)}
${showLocal ? localSection(v) : ""}
${shownPeers.map(edgeSection).join("\n")}
${footerHtml(v)}
</body></html>`;
}
