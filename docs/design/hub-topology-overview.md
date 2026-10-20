# Hub topology overview

Status: design contract for the Belt network overview and enterprise hub view.
The current Belt component draws one 1060 px SVG with all local models, hub
probes, and provider cards expanded. That is useful for a small installation,
but it cannot carry a network with several central hubs, team hubs, developer
machines, and many concurrent lanes. The large network reference is a scale
target, not a request to make every node visible at once.

## Questions the page must answer

1. Which hubs and routes are available, degraded, or unknown now?
2. Where is work flowing, how much, and over which observed hops?
3. Which hub, model, or lane accounts for a change in load or failures?
4. What could the viewer route to, even when it has had no recent traffic?

The overview opens at **hub level**. Its summary strip shows active lanes,
requests per minute, reported output tokens per second, failures, and the age
and coverage of those measurements. A zero is displayed only when a fresh,
complete measurement observed zero. Missing usage is shown as _unreported_.

## Browsing a large graph

| Level  | Initially visible                                                                   | Open on selection                                                   |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Estate | Central hubs, team-hub groups, local spokes, cloud gateways; aggregated edge counts | One hub group and its route/health summary                          |
| Hub    | Machine, Buckle, Belt/local-model summary, downstream hubs and providers            | Model inventory, lane count, recent routes, failures and throughput |
| Model  | Model group and instances, selected route history                                   | Lanes, traces, cache and token coverage                             |
| Lane   | Current target and recent observed hops                                             | Work item, route trace, time series and failure detail              |

Use stable positions within a selected scope. A refresh updates labels and
edges in place; it does not recenter the canvas, close an open drawer, or reset
zoom. Collapse idle model and lane lists by default. Aggregate busy fan-out as
`12 lanes` at a hub or model until the viewer opens it. At estate scale, show
bounded group nodes instead of hundreds of labels. Search by hub, model, work
item, lane or provider; results highlight the path and can be opened directly.
Breadcrumbs and a back action preserve the previous camera, filter, and time
window. A minimap is useful only after the graph exceeds the viewport; a
keyboard-accessible tree/list remains available beside the canvas.

The default layout follows the route direction: local spoke or selected origin
→ central/team hub → downstream hub or cloud gateway → provider. Multiple
central hubs are peers, not forced under one root. A cloud provider is a
destination behind the hub that actually forwarded to it. Configured routes
without observed hop evidence can appear as a faint planning layer, clearly
separate from measured traffic. The viewer can switch between **configured**,
**connected**, and **observed traffic** layers rather than conflating them.

## Traffic and animation

An edge carries `{from, to, window, request_count, output_tokens,
reported_token_count, failures, last_observed_at, evidence, coverage}`. A
configured edge has no traffic width. A fresh observed edge is 1–4 px wide
according to its measured rate; a compact legend gives the thresholds. Use a
cool neutral/blue baseline with amber for sustained load and red for failures,
not red solely because an edge is busy. Dashed gray means configured or probed
but unobserved. Unknown and stale are distinct from measured zero.

Flow animation is optional, subtle and restricted to edges with fresh observed
requests. Its direction is the recorded hop direction, and its speed is bounded
by measured requests per second. Multiple lanes on one edge become one flow
with a count, not overlapping particles. Pause animation when the tab is
hidden, when the viewer selects a historical interval, or under reduced-motion
settings. Static width, color, counts and the accessible list must carry the
same information without animation. No probe or configured route animates as
live work.

Selecting an edge opens a compact inspector: source → destination, requests,
reported input/output tokens, output tok/s, failures, active lane count,
measurement window, age, coverage and recent traces. Selecting a hub shows
its Buckle and local Belt model inventory in an expandable panel, rather than
growing every map card as inventory changes. A cloud gateway expands its
models in place or in the inspector; it does not unexpectedly navigate away.

## Telemetry contract

Use stable IDs for hubs, providers, models, lanes and edges. A human display
name is not an ID. The same request must retain its W3C trace ID and ordered
hop observations across Mac → hub → hub → provider. Each hop records origin,
destination, time, lane/work IDs when present, route decision, model, request
and token usage provenance. Do not infer a hub-to-provider hop from the local
spoke's provider counter. Provider totals and hop totals are separate views
until the trace joins them.

Publish a versioned snapshot with `observed_at`, `expires_at`, `generation`,
`scope`, and per-field coverage, followed by bounded deltas. Reconcile by
generation so a late update cannot restore a removed lane. The first payload
contains aggregate hub counts; detailed inventories and lane lists load on
selection. Time windows are selectable (live 1m/15m, 1h, 24h) and share one
clock across cards and edges. Keep raw hop events/trace references for
drilldown and bucketed series for the map. Never sum a Mac origin event and a
hub forwarded event as two independent requests in estate totals.

Enterprise viewers receive only hub summaries and permitted routes by
default. Local model names and lanes require the corresponding scope. The
server filters before aggregation and before deltas; hiding labels in the
browser is not an authorization boundary.

## Rendering and interaction

Lit owns controls, inspectors and accessible lists. SVG is sufficient for
the currently small graph; use level-of-detail aggregation and viewport
culling before considering Canvas or WebGL. uPlot remains the time-series
renderer in drilldowns, not the topology layout engine. Keep text at a
readable fixed scale while the graph pans/zooms; never shrink the whole page
to fit a wide network. Pan, wheel/keyboard zoom, fit selection, reset view,
and direct focus on search results need visible controls. Preserve page scroll
and map scroll independently. A resized viewport reflows the panel layout
without resetting selection or causing the page to jump on polling.

## Delivery slices and proof

1. **Truthful small map:** fix the current traffic windows, token coverage,
   provider and remote inventory expansion, hover details, and stable refresh.
   W982 owns this slice.
2. **Hub overview:** add stable IDs, summary nodes, search, selection drawer,
   layer/time controls, and collapsed inventories. Test with 1, 10 and 100
   hubs and sparse as well as dense routes.
3. **Observed flow:** join trace hop evidence to edges and lane counts, add
   bounded animation and uPlot drilldown. Verify a two-hop and three-hop
   request against gateway audits; stale, failed and missing telemetry must
   render distinctly.
4. **Enterprise scope:** authorization-filtered summaries, team/project
   filters and deep links; verify a viewer cannot query another tenant's
   model or lane detail through the map API.

Browser proof includes keyboard navigation, reduced motion, dark/light theme,
large and narrow screens, reconnect, changing inventory, and a live refresh
while scrolled and zoomed. Acceptance requires that a selected hub and camera
stay put through refresh and that every displayed rate has a named source,
window and coverage status.
