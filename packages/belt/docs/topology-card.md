# Connections topology card — inventory design + observed route details

W858.13 (2026-10-20). The Belt dashboard Connections card (`bin/dashboard-topology.js`)
keeps the INVENTORY card design: a fixed SVG map with one card per machine —
This Mac (local spoke :4101), one card per hub, one card per cloud provider —
linked by dashed configured/probe paths. It is NOT a live packet map.

## Measured vs configured semantics

- **Solid blue edge** = observed successful route, trace-backed, past 15 min
  (`evidence: "observed"`).
- **Dashed edge** = hub reachability probe or configured provider path
  (`evidence: "probe" | "configured"`); it asserts intent, never traffic.
- The coverage line states the split in prose; the legend repeats it. An
  endpoint is only NAMED as a provider when its identity is verified.

## Observed route details

When the network read model supplies `observedGraph`, the card renders a
collapsed `<details>` table under the map: route (from → to labels), requests,
failures, evidence per edge over the 15-minute window. Without it the card
says trace-backed route data is unavailable and shows the inventory only.

## IKEA hub → Copilot route

When an IKEA hub card is present, the direct Mac→Copilot edge is suppressed and
a configured edge `IKEA hub → Copilot provider` is drawn instead (dashed,
"configured") — Copilot lane traffic rides the IKEA hub gateway, so the direct
path would lie about the topology. The Copilot provider card itself stays.

## Scaling

SVG scales fluidly (`inline-size: 100%`, min 1060px / max 1500px) so wide hub
sets stay legible without a horizontal crawl on narrow viewports.

## Data sources

`/api/network` (observed graph + freshness), `/api/status`, `/api/remotes`,
`/api/supervisor`, `/api/model-access`, `/api/topology-context` (work counts).
Theme sync rides `refresh-dashboards.ts` so the runtime copy stays coherent
with the repo sources.
