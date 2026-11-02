// scripts/build-catalog.ts — the W2269.1.5 component catalog depth.
// Extends the W2269.1.1 skeleton: for every cataloged element, builds the
// component from its OWNING package (bun build --splitting — lit as a shared
// hash-named chunk, bundled from node_modules, never CDN) into
// catalog/elements/vendor/, then generates static side-by-side pages:
// prototype (native HTML, token-driven) vs component, in DARK, LIGHT and
// HIGH-CONTRAST panes. Pages carry BOTH token faces — the kernel theme
// (THEME_CSS, legacy --klh-* names) that the served board elements consume
// and the design-ui token build — so a pane renders the component the way
// the real surface does. Generated pages are committed (like the board
// vendor bundles); regenerate, never hand-edit.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { THEME_CSS } from "@klh/kernel/src/kernel.theme.module.ts";

const PKG = resolve(import.meta.dir, "..");
const CATALOG = join(PKG, "catalog");
const OUT = join(CATALOG, "elements");

/** One catalog row: the element, its owning-package source, and the native
 * HTML prototype it must match. Prototype styling is token-driven only. */
export interface CatalogRow {
	tag: string;
	src: string; // repo-relative element source (bun-build entry)
	summary: string;
	proto: string; // native-HTML prototype fragment
	props?: string; // demo wiring for the component pane
}

export const ELEMENTS: CatalogRow[] = [
	{
		tag: "klh-err-banner",
		src: "packages/suspenders/hooks/board-html/klh-err-banner.ts",
		summary:
			"Inline feed-failure banner — retry dispatches FeedRefreshRequestedEvent (feed) or ErrorDismissRequestedEvent (local).",
		proto: `<div class="proto-err" role="alert">feed /api/data failed: 502 upstream<button class="proto-retry" type="button">retry</button></div>`,
	},
	{
		tag: "klh-conn-banner",
		src: "packages/suspenders/hooks/board-html/klh-conn-banner.ts",
		summary:
			"Header connection banner — renders the mediator's conn verdict (live/stale/error dot + freshness), retry re-probes.",
		proto: `<p class="proto-conn"><span class="proto-dot"></span>live <span class="proto-dim">| decisions fresh</span> <button class="proto-retry" type="button">retry</button></p>`,
	},
	{
		tag: "klh-service-row",
		src: "packages/suspenders/hooks/board-html/klh-service-row.ts",
		summary:
			"Health-probe service row — badge/head grid, recovery causes + copyable steps from the probe sidecar verdict.",
		proto: `<div class="proto-row"><span class="proto-badge">UP</span><span class="proto-name">fleet-board</span><span class="proto-dim">:7799 · probed 12s ago</span><p class="proto-detail">verdict healthy · probe 21/21</p></div>`,
		props: `document.querySelector("klh-service-row").probe = {id:"svc-fleet-board",name:"fleet-board",port:7799,up:true,state:"up",detail:"verdict healthy",probed_at:new Date().toISOString(),observation:{source:"probe",target:"fleet-board",scope:"Local machine",kind:"http",observedAt:Date.now()-5000,expiresAt:Date.now()+600000},recovery:null};`,
	},
];

/** Prototype-pane styles: token-driven only — raw hex/px has zero baseline
 * here (the design-law guard enforces the same for components). */
const PROTO_CSS = `
.proto-err {
	color: var(--klh-danger-ink);
	background: var(--klh-danger-bg);
	padding: var(--klh-space-1) var(--klh-space-2);
	font: var(--klh-text-sm)/1.4 var(--klh-font-sans);
}
.proto-retry {
	background: none;
	border: var(--klh-line-hair) solid var(--klh-danger);
	color: var(--klh-danger-ink);
	padding: var(--klh-space-3);
	margin-left: var(--klh-space-3);
	cursor: pointer;
}
`;
const PROTO_CSS_B = `
.proto-conn {
	color: var(--klh-dim);
	font: var(--klh-text-sm)/1.4 var(--klh-font-sans);
	margin: 0;
}
.proto-dot {
	display: inline-block;
	width: var(--klh-space-3);
	height: var(--klh-space-3);
	border-radius: 50%;
	margin-right: var(--klh-space-2);
	background: var(--klh-ok);
}
`;
const PROTO_CSS_C = `
.proto-dim {
	color: var(--klh-dim);
}
.proto-row {
	font: var(--klh-text-md)/1.4 var(--klh-font-sans);
	color: var(--klh-ink);
}
.proto-badge {
	font-weight: 700;
	color: var(--klh-ok-ink);
}
.proto-name {
	font-weight: 600;
}
.proto-detail {
	color: var(--klh-dim);
	margin: var(--klh-space-1) 0 0;
}
`;
const PROTO = `${PROTO_CSS}${PROTO_CSS_B}${PROTO_CSS_C}`;
/** Page CSS: layout grid + theme-pane wrappers. Panes pin their theme via
 * [data-theme] on the section (root default = dark). */
const PANE_CSS = `
.pair {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: var(--klh-space-3);
}
.pair section {
	border: var(--klh-line-hair) solid var(--klh-edge);
	padding: var(--klh-space-3);
	background: var(--klh-panel);
}
.pair h2 {
	font: 700 var(--klh-text-sm)/1.2 var(--klh-font-sans);
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--klh-dim);
	margin: 0 0 var(--klh-space-2);
}
section[data-theme="light"] {
	color-scheme: light;
	background: var(--klh-surface);
}
`;
/** One element page: dark + light + high-contrast rows, prototype vs
 * component in each. The design-ui high-contrast theme loads as a theme
 * override; its tokens land via the linked themes css. */
export const pageHtml = (row: CatalogRow): string => `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<title>${row.tag} — fleet component catalog</title>
<link rel="stylesheet" href="./tokens.css" />
<link rel="stylesheet" href="./themes/light.css" />
<link rel="stylesheet" href="./themes/high-contrast.css" />
<style id="klh-theme-tokens">${THEME_CSS}</style>
<style>${PANE_CSS}${PROTO}</style>
</head>
<body>
<main>
<h1>${row.tag}</h1>
<p class="why">${row.summary}</p>
<div class="pair">
<section data-pane="prototype">
<h2>Prototype (native HTML)</h2>
${row.proto}
</section>
<section data-pane="component">
<h2>Component (Lit)</h2>
<${row.tag}></${row.tag}>
</section>
</div>
</main>
<script type="module" src="./${row.tag}.js"></script>
<script>${row.props ?? ""}</script>
</body>
</html>
`;
/** Build every cataloged element in ONE splitting build (shared lit chunk,
 * hash-named like the board vendor build) into catalog/elements/. */
export const buildElements = (repoRoot: string): void => {
	mkdirSync(OUT, { recursive: true });
	const suspenders = join(repoRoot, "packages/suspenders");
	const out = Bun.spawnSync(
		[
			"bun",
			"build",
			...ELEMENTS.map((r) => r.src.replace("packages/suspenders/", "")),
			"--root",
			"hooks/board-html",
			"--minify",
			"--production",
			"--splitting",
			"--chunk-naming",
			"vendor/lit-[hash].[ext]",
			"--outdir",
			OUT,
		],
		{ cwd: suspenders },
	);
	if (out.exitCode !== 0)
		throw new Error(
			`bun build catalog elements failed: ${out.stderr.toString().slice(0, 800)}`,
		);
};
/** Build all elements + emit the element pages. */
export const buildCatalog = (repoRoot: string): void => {
	buildElements(repoRoot);
	// Token faces ride WITH the generated pages (self-contained served dir).
	const dist = join(PKG, "src/tokens/dist");
	mkdirSync(join(OUT, "themes"), { recursive: true });
	for (const f of ["tokens.css"])
		writeFileSync(join(OUT, f), readFileSync(join(dist, f)));
	for (const t of ["light", "high-contrast"])
		writeFileSync(
			join(OUT, "themes", `${t}.css`),
			readFileSync(join(dist, "themes", `${t}.css`)),
		);
	for (const row of ELEMENTS)
		writeFileSync(join(OUT, `${row.tag}.html`), pageHtml(row));
};

if (import.meta.main) buildCatalog(resolve(PKG, "../.."));
