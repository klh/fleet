# Decision — spoke-side federation classification (W690)

Closes the "KEEP (phase-2 review)" row in `enterprise-posture-audit.md`
for the suspenders federation surfaces. Applies the audit's own decision
rule (move iff zero solo reach AND not defensive — it mints,
inventory-tracks, meters, or entitlement-maps). Decision record only: no
strips land here.

## Verdicts

| surface                                                                  | verdict         | deciding fact                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hooks/lib/federation.ts` + `hooks/bin/federation-pull.ts`               | **KEEP public** | spoke CLIENT of defensive policy distribution: pulls manifest + entitlements, keeps last-known, never blocks routing. Mints, stores and meters nothing hub-side. Rule 2 fails — it consumes, never originates. Runs on every spoke via `services.yaml` (`federation-pull`).     |
| `hooks/lib/federation-report.ts` + `hooks/bin/federation-report.ts`      | **KEEP public** | spoke POST side of usage ingest (the audit already pinned "spoke POST side is suspenders-side and stays"). Default OFF — no `federation.self_report` rule in the pulled manifest = no POST. Wire payload carries no actor/model names; private-domain aid rows are filtered.    |
| `hooks/lib/federation-peers.ts` + `hooks/bin/federation-peers.ts`        | **KEEP public** | pure puller (W362): reads declared peers' `/federation/policy-manifest`, content-addressed version = change detector, per-peer degradation. No table, no mint, no meter. Also imported by `hub-federation-status.ts` (W231 admin plane, public) — moving it would split a pair. |
| `hooks/board/routes-federation.ts` + `bin/federation-usage-html.ts`      | **KEEP public** | thin read client: capped server-side fetch of hub `/federation/usage` (key never reaches the browser), renders honest degradation. Solo hits the explanatory page (env unset). The hub route it reads is the UsageIngestProvider seam, so provider-less hubs 501 — page says so. |

## Why not move peers / board panel

- The overlay flip (W688.5/W688.6) is not done. Hub compose
  (`peer-pull` service) runs `federation-peers.ts` from the fleet source
  at the pinned ref; moving it makes the hub dependent on the overlay
  packaging (W688.4) that does not exist yet — an unforced outage risk
  for no classification gain.
- The board has no route-provider seam. Moving one panel route needs a
  new seam + injection path — more public surface than the code it would
  remove, violating "every move = one overlay export + one public seam
  use".

## Re-open triggers

Revisit (new decision record, never a silent strip) if ANY of:

1. a spoke-side file gains hub-origination logic (mint, enrol, store
   rollups) — it then fails rule 2;
2. the board gains a generic route-provider seam (then the usage panel is
   a cheap, clean move);
3. `peers` grows hub-only state (its own table, entitlement mapping).

## Verification

`rg -ln "federation-pull|federation-report|federation-peers|routes-federation"`
over `packages/` shows the importers (hub-federation-status.ts, board
`fleet-board.ts`, `routes-data.ts`, deploy compose/services). Tests stay
co-situated: `federation-pull`, `federation-report`, `federation-peers`,
`federation-board-page` suites.
