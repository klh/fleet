// hooks/bin/federation-work-html.ts — W370 the federated work view page:
// LOCAL scope first (this machine's open work), then one scope per
// declared edge — "the work THEY are responsible for". Server-rendered
// from a completed view (the route pulls; the page only renders), honest
// about degraded edges (reason + last-known counts). No client-side JS:
// everything travels as the server-rendered response.
import {
	FLEET_NAV_CSS,
	fleetNav,
	THEME_HEAD,
} from "@klh/kernel/src/kernel.theme.module.ts";
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

function itemRows(items: WorkFeedItem[]): string {
	return items
		.map(
			(it) =>
				`<tr><td class="id">${esc(it.id)}</td><td><span class="st st-${esc(it.state.toLowerCase())}">${esc(it.state)}</span></td><td>${esc(it.title)}</td></tr>`,
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
<table><thead><tr><th>id</th><th>state</th><th>title</th></tr></thead>
<tbody>
${itemRows(p.feed.items)}
</tbody></table></section>`;
}

// W2784.6.1.4 (W2269.1.4 scope 3): the page rides the kernel theme — every
// colour, type size, spacing step and radius is a --klh-* token; the
// literal light palette the W370 page carried is retired.
export const pageCss =
	(): string => `body { font: var(--klh-text-lg)/1.45 var(--klh-font-sans); margin: 0; padding: 0 var(--klh-space-6) var(--klh-space-7); color: var(--klh-ink); background: var(--klh-bg); }
main.fwork { max-width: 60rem; margin: 0 auto; }
h1 { font-size: var(--klh-text-xl); letter-spacing: .08em; margin: var(--klh-space-5) 0 var(--klh-space-2); }
h2 { font-size: var(--klh-text-md); margin-bottom: var(--klh-space-2); }
.meta { color: var(--klh-dim); font-size: var(--klh-text-sm); margin-top: 0; }
.degraded { color: var(--klh-danger-ink); font-size: var(--klh-text-md); }
.badge { font-size: var(--klh-text-xs); padding: var(--klh-space-1) var(--klh-space-3); border-radius: var(--klh-radius-lg); vertical-align: middle; }
.badge.live { background: var(--klh-ok-bg); color: var(--klh-ok-ink); }
.badge.deg { background: var(--klh-danger-bg); color: var(--klh-danger-ink); }
table { border-collapse: collapse; width: 100%; font-size: var(--klh-text-md); }
th, td { text-align: left; padding: var(--klh-space-2) var(--klh-space-3); border-bottom: 1px solid var(--klh-edge-soft); }
th { color: var(--klh-dim); font-weight: 500; }
td.id { color: var(--klh-ink-2); white-space: nowrap; font-family: var(--klh-font-mono); }
.st { font-size: var(--klh-text-xs); padding: var(--klh-space-1) var(--klh-space-2); border-radius: var(--klh-radius-lg); background: var(--klh-surface-hi); }
.st-ready { background: var(--klh-ok-bg); color: var(--klh-ok-ink); }
.st-claimed, .st-running { background: var(--klh-accent-bg); color: var(--klh-accent); }
.st-blocked, .st-failed { background: var(--klh-danger-bg); color: var(--klh-danger-ink); }
section.scope { margin-top: var(--klh-space-6); }
footer { margin-top: var(--klh-space-7); color: var(--klh-dim); font-size: var(--klh-text-xs); }`;

function localSection(v: FedWorkView): string {
	return `<section class="scope">
<h2>LOCAL — ${esc(v.local.hub)}</h2>
<p class="meta">open=${String(v.local.total)}${v.local.trunc ? ` (showing ${String(v.local.items.length)}, capped)` : ""} · generated ${esc(v.local.generated_at)}</p>
<table><thead><tr><th>id</th><th>state</th><th>title</th></tr></thead>
<tbody>
${itemRows(v.local.items)}
</tbody></table></section>`;
}

const footerHtml = (v: FedWorkView): string =>
	`<footer>W370 federated work view · me=${esc(v.me)} · edges light up with HUB_PEERS (or stack.json hubs.&lt;me&gt;.peers) + SUSPENDERS_FEDERATION_WORK_TOKEN</footer>`;

export function federationWorkPage(v: FedWorkView): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>federated work — ${esc(v.me)}</title>
${THEME_HEAD}
<style>
${pageCss()}
${FLEET_NAV_CSS}
</style>
</head>
<body>
${fleetNav("suspenders", "workflows")}
<main class="fwork">
<h1>Federated work — me=${esc(v.me)}</h1>
<p class="meta">generated ${esc(v.generated_at)} · each section is one hub's OWN open work (hub→spoke boundary: a spoke's items never travel via another hub's feed)</p>
${localSection(v)}
${v.peers.map(edgeSection).join("\n")}
${footerHtml(v)}
</main>
</body></html>`;
}
