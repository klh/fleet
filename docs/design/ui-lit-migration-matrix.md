# Fleet UI → Lit migration matrix (W2269)

Umbrella item W2269 ("Migrate all Fleet UI to Lit webcomponents under
Engineering Standard", owner-go 2026-10-31). This file is the committed
inventory + destination map required by the mission brief: every served
entrypoint and rendering/side-effect owner, mapped to its destination
component/mediator. No omitted surface behind a claim of "all".

Authority, in order:

1. Owner directives on W2269 / W2267 (latest wins).
2. `docs/paas-engineering-standard-2026-10-23.md` (the 23 Oct Engineering
   Standard; supersedes older CustomEvent.detail and vendored-source
   doctrine — Lit stays the exact-pinned npm `lit` 3.3.3, bundled locally,
   never CDN).
3. Approved card close-up `09-tight-time-rail.png` and full-page LIGHT/DARK
   proposals (`10-fleet-board-light.png`, `11-fleet-board-dark.png` +
   `full-page-design-reference.md`) in the owner's machine-local Codex
   outputs directory for 2026-10-29 (exact paths ride the W2269 item
   description; the distilled language below is authoritative for lanes
   that cannot open the PNGs).

Written owner requirements override raster defects: configurable border
color independent of status; solid parents / dashed nested children; bold
title hierarchy in both themes; truthful bins; full local+UTC time/token
hover; exactly 1 CSS px center-out duration line with zero own spacing;
tiny tight axis; flush neutral segmented action rail including Retry and
Recover → Ready. Card/column text stays readable at real widths; the board
scrolls horizontally as needed. Mockup telemetry in the PNGs is
illustrative, never production data.

## Approved design language (distilled, for lanes that cannot open the PNGs)

Card (from 09, approved): status color chip (small filled square) + bold
tracked uppercase status label top-left; relative age ONCE, top-right,
mono muted; task ID on its own line, prominent mono; bold sans title
below; quiet liveness/context meta lines; hairline divider; MODEL / HOST
ruled columns (tiny tracked uppercase labels, mono values); four stat
cells split by vertical hairlines — bold value over tiny muted label
(tok, time, tok/m, cache); missing values render unknown ("—"), never
measured 0; activity histogram ~62px, thin bottom-aligned bars, truthful
bins; amber elapsed-duration line flat on the baseline (1 CSS px, zero own
spacing, center-out); tiny tight axis row: start stamp · `CET · N
min/bin` · end stamp; bin hover tooltip shows local + UTC time and
fresh/cached/output token counts (dark in both themes); STRIP footer:
full-width neutral segmented action rail — failed cards `Retry ·
Recover → Ready · Prompt ↗`, other states keep model/effort/start or
reassign/release/report/prompt controls; solid border for parents,
dashed for nested children; configurable border color independent of
status; warm paper light / deep ink dark; MIT Press-inspired editorial
grid, restrained sans titles, mono IDs/metadata; no decorative gradients.

Full page (from 10/11, proposed): masthead `||| KLH·FLEET` + product nav
(belt / buckle / suspenders / local) + right icon nav (Models, Routes,
Workflows, Services, Metrics, Hub, Settings); console header with page
title, search ("Search tasks, lanes, decisions"), Live dot, ledger age,
gated count, project select, theme toggle, avatar; "+ Orchestrate — Turn
a goal into a plan" strip; tab row (Decisions Tasks Lanes Activity Report
Governor Setup Usage) with active underline; counts/evidence row
("Attempt view ⌄", per-state chips with counts, evidence string, checked
timestamp); seven columns READY / WAITING / CLAIMED / BLOCKED / FAILED /
DONE / CANCELLED with a full-width accent rule per column header and
right-aligned count; cards carry their OWN status accent (a FAILED child
sits truthfully inside WAITING under its split parent, joined by an
elbow connector); state-gated card actions (Model/Effort selects + Start
▶ only on READY; Reassign/Release on CLAIMED; Report on DONE). Dark
theme: surface lightness steps + hairlines carry elevation (no ported
shadows); accents retuned lighter; active-tab underline flips to the ink
color.

## Inventory — Suspenders board (port 7799)

The served page is one string template, but the client layer has ZERO
`innerHTML` (legacy chunks build DOM via `createElement`/`replaceChildren`)
and a mature Lit layer already ships as 7 `/vendor/*.js` ES modules built
from `hooks/board-html/klh-*.ts` sources by `scripts/build-vendor.ts`
(`bun build --splitting`, hash-named lit chunks, BSD banner). The
migration is therefore retirement of the imperative string-chunk core +
standardization, not a from-scratch rewrite.

| Surface | Current owner (file:lines) | Mechanism | Destination | Slice |
| --- | --- | --- | --- | --- |
| Board server | `hooks/bin/fleet-board.ts` (282) | Bun.serve, 20-handler first-match chain | unchanged server; UI only | — |
| Page shell + tokens | `hooks/bin/fleet-board-html.ts` (527) | `String.raw` template, 18 inline chunks + 7 `/vendor/*.js`, `:root` work-state hues; W2267.1 adds `--board-*` editorial tokens in-flight | semantic light-DOM document shell + theme tokens (W2267.1 lands the shell; tokens later lift to the shared package, names kept) | W2267.1 → W2269.1 |
| Decisions tab | `hooks/board-html/decisions.ts` (501), `history.ts` (67) | imperative chunk (`renderDecisions`, gated queue) | `klh-decisions` feature + mediator; typed events; zod feed schema | W2269.3 |
| Tasks tab / drawer | `hooks/board-html/tasks.ts` (1129 — 71 lines under the 1200 stop rule; decompose-while-migrating, never grow) | imperative chunk: owner select, pollTasks, pollExecutors, spend series, `renderKanban` (730), `renderDrawer` (1047) | split by responsibility: kanban board feature, task drawer feature, spend-series element, executors service; card visual language owned by W2267.4.x | W2267.4.x (card/kanban) + W2269.3 (rest) |
| Fleet/governor tab | `hooks/board-html/renders.ts` (388): renderFleet/renderLlm/renderClaims/renderFacts/renderDone/renderEvents/renderHubObservations/renderFleetLanes/renderFleetHistory | imperative chunk over `/api/data` | `klh-fleet-*` feature family + data service | W2269.3 |
| Activity tab | `hooks/board-html/activity.ts` (105) | imperative chunk | `klh-activity` feature (W2267.2 owns the spectral activity hover) | W2267.2 + W2269.3 |
| Report tab | `hooks/board-html/report.ts` (83, W1198) | feed renderer | `klh-report` feature | W2269.3 |
| Setup tab | `hooks/board-html/setup.ts` (66) | imperative chunk | `klh-setup` feature | W2269.3 |
| Orchestrator | `hooks/board-html/orch.ts` (140) + server `board/routes-orch.ts` + `board/prompt-transform.ts` (437) | imperative chunk + POST | `klh-orchestrate` feature (form-mediator pattern, Zod-parsed) | W2269.3 |
| Task drawer aux | `hooks/board-html/tail.ts` (86), `diff.ts` (160), `ship.ts` (69), `launch.ts` (67), `klh-task-trace.ts` (167), `klh-prompt-preview.ts` (391, Lit) | imperative chunks + Lit | fold into the task-drawer feature; trace/prompt-preview stay Lit | W2269.3 |
| Tabs shell | `hooks/board-html/tabs.ts` (257) + `<klh-board-tabs>` (Lit, 139) | hash routing `#tab?key=v` | Lit tabs (exists) + `URLPattern`-style hash router service; deep links preserved | W2269.3 |
| Feeds/polling | `hooks/board-html/feed-store.ts` (550) + `feed-schemas.ts` + `boot.ts` (24) | FeedStore: ETag/304, adaptive cadence, leader election; 1 Hz `setInterval(tick)`; page-global string-chunk state | FeedStore stays THE service; legacy `renderAll`/global-state core retires into mediators consuming FeedStore | W2269.3 |
| Topbar | `hooks/board-html/klh-topbar.ts` (346, Lit) + `lib/theme.ts` fleetNav (286) | Lit + theme tokens | stays; W2267.1 editorial language in-flight | W2267.1 |
| Conn/err banners | `klh-conn-banner.ts`, `klh-err-banner.ts` (Lit) | Lit | stays | — |
| Recovery | `klh-recovery.ts` (152, Lit) | Lit | stays | — |
| Enterprise zone | `klh-ent-zone.ts` (177) + `klh-ent-panels.ts` (332, 7 elements) | Lit | stays (already standard-shaped) | audit only |
| Usage tab | `hooks/bin/usage-page-html.ts` (363) + `usage-*.ts` family (~1.9k, mostly Lit panels) + `usage-chrome.ts` (238) | payload shaper + Lit panels | Lit panels stay; chrome/headers standardize; `usage-cache-drill.ts` (727) audit | W2269.4 |
| Console pages | `hooks/bin/console-html.ts` (586): /console/buckle, /console/local, /console/settings | string page builders + `<klh-topbar>`, `klh-console-cards.ts` (402), `klh-console-forms.ts` (272) | Lit console features + mediators; forms via ElementInternals + form-mediator | W2269.4 |
| Hub admin | `hooks/bin/hub-admin-html.ts` (19) + `klh-hub-admin.ts` (600, Lit) | consolePage shell + Lit | stays; shell standardizes | W2269.4 |
| Federation pages | `hooks/bin/federation-usage-html.ts` (270), `federation-work-html.ts` (97) | string pages | Lit features | W2269.4 |
| Posture/network/service rows | `klh-posture-panel.ts` (269), `klh-network-card.ts` (392), `klh-service-row.ts` (292) + `service-row-model.ts` | Lit | stays | audit only |
| lib/ui helpers | `hooks/lib/ui/klh-{tree,menu,heatmap,status-grid,progress,tag}.ts` (964) + `icons.ts` (93) | template/DOM helpers, no Lit import | lift to shared elements package as Lit leaves (W2269.1 consumes them) | W2269.1 |
| Theme | `hooks/lib/theme.ts` (286) — one of FOUR byte-identical copies (belt `bin/klh-theme.ts`, local `bin/klh-theme.ts`, kernel `src/kernel.theme.module.ts`) + `klh-theme-sync.ts` ×2 | data-theme + `--klh-*` tokens, pre-paint JS, fleetNav | single-source in kernel (lowest shared package; kernel imports nothing); consumers import by package name | W2269.1 |
| Board settings | `hooks/lib/board/board-config.ts` (601) | JSON config-over-code | unchanged | — |

## Inventory — Belt (dashboard :7791, "Models" page)

| Surface | Current owner | Mechanism | Destination | Slice |
| --- | --- | --- | --- | --- |
| Dashboard page | `packages/belt/bin/dashboard.ts` (1185; PAGE template 375–652) | string template + sanctioned `esc()`/`DOMParser`/`replaceChildren` mount (no innerHTML) | semantic shell + Lit features; retire the string PAGE | W2269.2 |
| Topology | `bin/dashboard-topology.js` (984; `belt-topology`, `-details`, `-model-inventory`), `-hubs.js` (629) | Lit, vendored `bin/vendor/lit.js` via `ui/lit-vendor.ts` | stays Lit; rebuild from npm `lit` (drop the checked-in vendor copy) | W2269.2 |
| Observability | `bin/dashboard-observability.js` (515; `belt-supervisor`, `belt-trends`, uPlot) | Lit | stays; uPlot vendored CSS/JS continues | W2269.2 |
| Model access | `bin/dashboard-model-access.js` (338) | imperative `createElement` chains, no Lit | rewrite as Lit leaf | W2269.2 |
| Threads mark | `bin/threads-mark.js` (190) | raw customElements | Lit leaf + register.ts | W2269.2 |
| Theme | `bin/klh-theme.ts` (286) + `klh-theme-sync.ts` (202) | byte-identical copy | kernel single-source | W2269.1 |
| MCP error page | `bin/mcp-server.ts:342-345` | one-off inline string | trivial Lit-free semantic HTML (or console shell) | W2269.4 |

Belt UI browser tests live under `packages/suspenders/e2e/`
(`belt-dashboard.spec.ts` 520, `belt-topology*.spec.ts` ~1100) — parity
surface for W2269.2.

## Inventory — other packages

| Package | Surface | Verdict |
| --- | --- | --- |
| `local` | `bin/dashboard.ts` (318) + `bin/dashboard-page.html` (113, inline LitElement `<fleet-local-board>`) + vendored `bin/vendor/lit-shared.js` (:7792 bar.local) | already Lit; extract module, adopt shared build, kernel theme | W2269.4 |
| `buckle` | none (JSON/SSE gateway only) | no UI — confirmed | — |
| `local-llm`, `blam`, `telemetry`, `settings`, `test-kit` | none (config/CLI/test kits) | no UI | — |
| `speedy` | statusline (terminal ANSI); lit dep referenced only by skill templates | no browser UI | — |
| `kernel` | `src/kernel.theme.module.ts` (286, theme copy #4); host-guard touches text/html only for write-cookie; servicemon JSON | owns the future single theme home | W2269.1 |
| `decant` | React 19 SPA (~22.9k lines, `src/ui/` + SSR reports, echarts, own token JSONs) | OUT OF SCOPE: vendored third-party dosu-ai/decant toolkit (Apache-2.0, law-exempt per root AGENTS "vendored decant exempt"). Backend-only/vendored-source exclusion in the W2269 scope. Tracked here so "all" is honest; revisit only by owner decision. | — |
| `suspenders` deploy | `deploy/healthcheck/probe.ts` serves verdict status codes + JSON (no HTML page) | no UI | — |
| `suspenders` hooks bins | fleet-report (CLI shim), notify, knowledge-api (JSON API) | no HTML face | — |

## Standard → implementation mapping (Engineering Standard §UI/Events/Zod/Layers)

| Standard requirement | Fleet realization |
| --- | --- |
| Native first; no div/span role substitutes | existing native `<select>`, `<details>`, `<dialog>`, `<table>`, `<form>` stay; components render native elements (`<klh-x>` wraps real `<button>` etc.) |
| Stateless leaves; side effects only in mediators/services | FeedStore + board services stay the data layer; new `<klh-*-mediator>` elements (pattern: existing `klh-board-mediator.ts`) hold polling/mutations; leaf components get properties in / typed events out |
| Typed Event subclasses, readonly fields, HTMLElementEventMap, bubbles+composed, mediator stopPropagation, cancelable vetoes, noun-verb naming | new `packages/design-ui` events kit (`KlhEvent` base + per-domain event modules + global `HTMLElementEventMap` registration); legacy `CustomEvent.detail` emitters migrate with their chunk |
| Zod-first schemas; safeParse at boundaries | `feed-schemas.ts` lift into the shared package as wire schemas; every new event/property/wire shape gets a named `*zod.ts`; existing server routes keep their ETag/wire behavior |
| Layers tokens/scss/foundations/elements/patterns/features/mediators; lowest shared package; no reach-ins | new `packages/design-ui` (`@klh/design-ui`) for tokens build + events + foundations + shared elements; kernel hosts the theme module; per-package features stay in their owning package (`hooks/board-html/`, belt `bin/`); imports ride `@klh/*` (import law W1249) |
| `namespace.thing.role` filenames; `.zod.ts`, `.e2e.ts`, thin `index.ts`; class/register split; one register.ts per workspace | new files follow `klh.<thing>.<role>.ts`; existing filenames grandfathered; each workspace gains `register.ts` (customElements.define separated from class modules) |
| Semantic token sources; light/dark/high-contrast overrides; no raw hex/px in components; SCSS compiled to static styles; CSS custom properties at runtime | kernel theme tokens stay the runtime face (`--klh-*`); `packages/design-ui` adds the semantic source + sass-compiled static styles (one `.scss` per component, build-time compiled, shadow-compatible) |
| Exact-pinned npm lit, bundled, no CDN | already true (`lit` 3.3.3 in belt/local/speedy/suspenders; build-vendor bundles from node_modules); retire the checked-in copies (`belt/bin/vendor/lit.js`, `local/bin/vendor/lit-shared.js` rebuild instead of commit) |
| SCSS compiled to Lit static styles | `sass` is NEW to the repo (zero .scss today) — adding it follows the dependency allowlist procedure: exact-pinned dep + declared in the consuming package.json + the check-deps guard updated in the same landing |
| URLPattern/history/popstate routing; deep links preserved | hash router service replaces the string-chunk `applyHash*` trio; `#task=<id>&proj=` deep links keep working (pinned by existing e2e) |
| Catalog side-by-side prototype + component, both themes, axe, WCAG AA | catalog page under `packages/design-ui` catalog/; Playwright `visual` + `a11y` projects; token contrast test |
| Playwright-only tests, `*.e2e.ts`, tags | all new tests `*.e2e.ts` via test-kit; no new `*.test.ts` (W1294 guard) |
| 1200 stop / 1500 cap; qlty; regression checks against legacy render/side-effect/token/registration | `tasks.ts` decomposed while migrating (never grown); law-guard extensions pin: no raw hex/px in component styles, no CDN imports, no div[role] interactives, legacy chunk imports fail once retired |

## Slices (work-graph children of W2269)

| Slice | Scope | Depends on |
| --- | --- | --- |
| W2267.1 (external, live) | Board editorial shell, `--board-*` tokens, topbar/tabs language | — |
| W2267.2/.3/.4.1/.4.2/.5 (external) | Spectral activity, Retry/Recover, Lit task-card, live card wiring, board browser acceptance | family plan |
| W2269.1 | Shared foundations: `packages/design-ui` (tokens source + build, events kit, SCSS plugin, zod wire schemas, register pattern, catalog harness skeleton); theme quadruplication → kernel single-source (after W2267.1 lands, names kept); lift `hooks/lib/ui` helpers as elements | — |
| W2269.2 | Belt dashboard: retire string PAGE + DOMParser mount; model-access/threads-mark → Lit; rebuild vendor from npm lit; parity vs `suspenders/e2e/belt-*.spec.ts` | W2269.1 |
| W2269.3 | Board legacy chunks (everything EXCEPT W2267 family scopes): decisions, history, renders/fleet family, report, setup, orchestrator, drawer aux, tabs hash router, boot/renderAll retirement; decompose `tasks.ts` non-card parts | W2269.1; W2267.1 landed; coordinate .2/.3/.4.x file ownership |
| W2269.4 | Console + usage + federation + hub-admin + local bar pages → Lit; belt MCP error page; unify vendor builds | W2269.1 |
| W2269.5 | Catalog (prototype vs component, both themes), visual + a11y projects, law-guard extensions (raw hex/px, CDN imports, div[role], legacy-path regressions), final matrix reconciliation | W2269.1 + elements landing |
| W2269 umbrella (this lane) | Matrix (this file), dispatch coordination, integration/parity proof, closing | all above |

Model pin: every W2269 child is GLM-5.3 FULL, never Flash — dispatched only
through the task-local executor pin (`.fleet/W2269-route-pin/.prefer`, sole
unquoted `must=glm-5.3`) with `dispatch --repo <pin> --item <id> --no-belt`,
admission respected (no bypass, no peer kills, no global posture change).
Titles are OWNER-GATED so generic claiming stays machine-blocked.

## Out-of-scope dispositions (tracked, not waved away)

- `decant` React SPA — vendored third-party toolkit, law-exempt; out of
  scope by the mission's own exclusions (recorded above).
- Server route handlers (`board/routes-*.ts`), store, govdb — backend, not UI.
- Generated/bundled outputs (`hooks/board-html/vendor/*`,
  `belt/bin/vendor/lit.js`) — rebuilt from source, never hand-edited.

## Verification surfaces (how slices prove their work)

- Board harness: `packages/suspenders/test/helpers/board-harness.ts`
  `startBoard(label, {env?, args?})` — spawns the real board on an OS-picked
  loopback port; runtime-neutral (shared by the bun-test corpus and the
  Playwright corpus). `packages/test-kit` provides `serveStub`, `scratchWorld`,
  `freePort`, `waitUp`, `runCli`.
- GUI corpus: `packages/suspenders/e2e/*.spec.ts` (44 chromium specs, config
  `packages/suspenders/e2e/playwright.config.ts`, 1440×900, browsers resolve
  from `~/Library/Caches/ms-playwright`, never CDN). Run idiom:
  `bun --bun playwright test --config=packages/suspenders/e2e/playwright.config.ts <spec>`.
  `chromium-bidi` IS in bun.lock — headless chromium is available to lanes.
- Belt parity: `packages/suspenders/e2e/belt-dashboard.spec.ts` (520),
  `belt-topology*.spec.ts` (~1100 lines) drive the real belt dashboard.
- Vendor build face: `bun run build:vendor` in `packages/suspenders`
  (`scripts/build-vendor.ts` — production split build, prune, BSD banner);
  belt/local equivalents rebuild `bin/vendor/*` from the npm `lit` dep.
- Gates that bite UI work: on-write `hooks/gates/files.ts`
  (innerHTML/document.write block; createElement only inside lit-importing
  web components; 1500 hard / 1200 warn; qlty fmt), mutation-size (>40
  changed lines on an EXISTING file denies — prefer new files or mechanical
  `sd`/`ast-grep`/`bun -e` splices), content gate (payload must transpile),
  scrub gate on commit/push (added-line ruleset), W511 completion-marker scan
  on the closing diff, and the `NEAR_CAP_PINNED` shrink-only ratchet in
  `tests/law-guards.e2e.ts` (new files born under 1200 lines).

