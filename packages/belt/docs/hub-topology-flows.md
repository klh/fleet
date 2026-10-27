# Hub topology overview — flow layer (W858.7.32, slice 3)

The hub-first topology card (`bin/dashboard-topology-hubs.js` + model in
`bin/dashboard-topology-hubs-model.js`) draws the slice-3 flow layer on top of
the slice-2 hub overview: measured edge widths, rate-bounded flow animation,
lane counts, and the uPlot edge drilldown. Design contract:
`docs/design/hub-topology-overview.md` slice 3.

## Where each number comes from

- **Edge width (1–4px)** — measured hops/min in the selected window:
  ≥0.5 → 2px, ≥3 → 3px, ≥8 → 4px, else 1px (`edgeWidth`).
- **Flow animation** — only fresh (≤60s) observed hops animate
  (`FRESH_HOP_MS`), at a duration bounded by the measured rate
  (≥8/min → 2.5s, ≥1/min → 6s, else 12s; `edgeFlow`). The CSS rides
  `stroke-dasharray` + `@keyframes hub-flow`; `prefers-reduced-motion` turns
  it off; hiding the tab pauses it (`.flow-paused`).
- **Lanes / active lanes** — `COUNT(DISTINCT lane)` per edge from the
  projection's `request_edges.lane` (snapshot v2 fields `lanes` /
  `activeLanes`). A ledger target edge has no lane column in `route_audit`,
  so it reports `lanes: null` → the UI says "lanes unreported" rather than
  guessing.
- **Joined traces** — consecutive W3C trace hops map onto measured edges by
  `from`/`to` node ids (never by the edge-id string dialect, which differs
  between producer and fixture). Ledger target edges join nothing: the local
  ledger alone never proves a provider hop.
- **60s series (uPlot drilldown)** — snapshot v2 buckets each edge into 15×60s
  bins (server caps at the 100 most-recently-active edges, `coverage.seriesEdges`
  states the count). The drawer draws `hops/min` + `failed` via uPlot with a
  shadow-scoped subset of the u* chrome classes (vendor CSS cannot reach into
  a shadow root); without the series (v1 snapshot or capped edge) the drawer
  says so instead of faking a grid.

## Degrade order (all honest, all distinct)

fresh trace edge → animated · stale (>60s) → numbers stay, dashes stop, the
drawer says "stale, flow off" · failed hops → red · v1/missing telemetry →
"lanes unreported" + no grid · ledger evidence → dashed gray, never animated,
joined traces empty with the never-claims-a-provider-hop note.

## Tests

- Unit: `packages/belt/test/dashboard-topology-hubs.test.ts` (edgeWidth tiers,
  edgeFlow freshness/duration bounds, linkFlows join, hubOverview integration).
- Browser: `packages/suspenders/e2e/belt-topology-flows.spec.ts` (widths,
  durations, aria lane words, drilldown + canvas, stale, reduced motion,
  hidden-tab pause, failed red, v1 degrade, ledger never-animates).
- Server: `packages/buckle/test/topology-read-model.test.ts` (v2 snapshot:
  lanes/activeLanes/series buckets, seriesEdges coverage).
