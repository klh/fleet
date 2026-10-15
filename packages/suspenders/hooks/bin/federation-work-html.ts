// hooks/bin/federation-work-html.ts — W370 the federated work view page:
// LOCAL scope first (this machine's open work), then one scope per
// declared edge — "the work THEY are responsible for". Server-rendered
// from a completed view (the route pulls; the page only renders), honest
// about degraded edges (reason + last-known counts). No client-side JS:
// everything travels as the server-rendered response.
import type {
	FedWorkRow,
	FedWorkView,
	WorkFeedItem,
} from "../lib/federation-work.ts";

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

const pageCss =
	(): string => `body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1a1a2e; background: #fafafa; }
h1 { font-size: 1.3rem; }
h2 { font-size: 1.05rem; margin-bottom: 0.3rem; }
.meta { color: #555; font-size: 0.8rem; margin-top: 0; }
.degraded { color: #a33; font-size: 0.85rem; }
.badge { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 0.6rem; vertical-align: middle; }
.badge.live { background: #d8f3dc; color: #1b4332; }
.badge.deg { background: #ffe5d9; color: #7f2f13; }
table { border-collapse: collapse; width: 100%; font-size: 0.82rem; }
th, td { text-align: left; padding: 0.28rem 0.5rem; border-bottom: 1px solid #e5e5e5; }
th { color: #555; font-weight: 500; }
td.id { color: #555; white-space: nowrap; }
.st { font-size: 0.72rem; padding: 0.08rem 0.4rem; border-radius: 0.5rem; background: #e8e8f0; }
.st-ready { background: #d8f3dc; }
.st-claimed, .st-running { background: #dbe7ff; }
.st-blocked, .st-failed { background: #ffe5d9; }
section.scope { margin-top: 1.6rem; }
footer { margin-top: 2rem; color: #777; font-size: 0.72rem; }`;

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
	`<footer>W370 federated work view · me=${esc(v.me)} · edges light up with HUB_PEERS (or stack.yaml hubs.&lt;me&gt;.peers) + SUSPENDERS_FEDERATION_WORK_TOKEN</footer>`;

export function federationWorkPage(v: FedWorkView): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>federated work — ${esc(v.me)}</title>
<style>
${pageCss()}
</style>
</head>
<body>
<h1>Federated work — me=${esc(v.me)}</h1>
<p class="meta">generated ${esc(v.generated_at)} · each section is one hub's OWN open work (hub→spoke boundary: a spoke's items never travel via another hub's feed)</p>
${localSection(v)}
${v.peers.map(edgeSection).join("\n")}
${footerHtml(v)}
</body></html>`;
}
