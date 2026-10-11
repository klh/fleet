# Enterprise packaging v0 — SKUs, seat bands, gate map (W263)

Status: v0 draft for owner approval (2026-10-11). Numbers are proposal,
not commitment. Grounded in the shipped boundary: public fleet (BUSL 1.1,
7 packages) vs klh-remote overlay (`suspenders-remote`/`belt-remote`/
`buckle-remote`, W232 record; W233 posture audit).

## The envelope

Owner-set platform envelope: **$105–$190 per seat / month**, list price,
annual commitment. Every SKU × band below stays inside it — no price
breaks the floor or the ceiling. Monthly billing +15%.

## Seat definition

A seat = one **named human operator** with an authenticated identity
(auth-ON user or OIDC principal). Agent lanes are NOT seats — lanes ride
per-lane `bksk_` keys minted by a seat holder's admin key. Pricing
follows humans because lane count is unbounded by design.

## SKU tiers

### Core — $0 (public fleet)

Everything installable from this repo today: `suspenders`, `belt`,
`buckle`, `speedy`, `local`, `local-llm`, `blam`. Solo posture — one
machine, per-lane key minting, work graph + coord plane, belt dashboard,
swarm router `:4000`, health-probe sidecars, scrub gate, full defensive
security (gate, binds, allowlists, JWT validator seam, JWKS).

Federation surfaces answer honest 501s (`buckle.no_federation`) — the
seams are public, the providers are not.

### Team — self-host hub for one org

One hub, auth ON, shared operation. Adds the single-hub half of the
klh-remote overlay:

- hub profile defaults + hubctl deploy lifecycle
- auth ON: multi-user token issuance/revocation (W231), admin GUI
- per-repo pin policies on the buckle gateway
- usage metering ingest + rollup (hub-side, W233.2)
- multi-user budget ceilings (teams/ceilings read surface)

### Enterprise — multi-hub federation + IdP

Everything in Team, plus:

- OIDC/IdP auth enforced (W191), IdP-neutral validator seam
- multi-hub federation: spoke enrollment, hub-to-hub peers (W322/W362)
- policy manifest distribution + CR queue (W233/W233.3), signed
  manifests + JWKS serve
- entitlements menu (W233.1) — the runtime SKU→feature map itself
- audit trails, federation usage reporting surface

The entitlements menu is also the enforcement mechanism: SKUs map to
entitlement sets checked at the gate; an unlicensed feature 501s, it
does not fail open.

## Seat bands (list, per seat/month, annual)

| band      | Team | Enterprise |
| --------- | ---- | ---------- |
| 5–24      | $145 | $190       |
| 25–99     | $120 | $160       |
| 100–249   | $105 | $135       |
| 250–499   | —    | $120       |
| 500+      | —    | $105       |

- Team starts at 5 seats; below that Core is the honest answer.
- Team collapses to the $105 floor at 100 seats — Team is not the
  volume SKU; larger orgs land on Enterprise.
- Both SKUs stay inside the envelope at every band.

## Enterprise-gated vs public core (code evidence)

| capability                          | tier       | where it lives (W232/W233)                        |
| ----------------------------------- | ---------- | ------------------------------------------------- |
| gate, binds, allowlists, key mint   | Core       | public buckle (defensive, W233 KEEP verdicts)     |
| JWT validator seam, JWKS crypto     | Core       | public buckle (defensive primitives)              |
| solo work graph + coord plane       | Core       | public suspenders                                 |
| multi-user tokens + admin GUI       | Team       | W231 (already overlay)                            |
| hub profile + hubctl fleet deploys  | Team       | suspenders-remote                                 |
| per-repo pin policies               | Team       | buckle-remote                                     |
| usage metering ingest/rollup        | Team       | federation-usage (W233.2 overlay)                 |
| OIDC enforced auth                  | Enterprise | suspenders-remote (W191)                          |
| spoke enrollment + hub peers        | Enterprise | federation-spokes (W233), peers (W322/W362)       |
| policy manifest + CR queue          | Enterprise | federation-manifest (W233.3) + federation-cr CLI  |
| entitlements menu                   | Enterprise | W233.1 overlay                                    |
| teams/ceilings multi-user budgets   | Team       | read-side public, DDL shared (phase-2 candidate)  |

Public keeps defensive security and honest 501 seams — packaging never
moves a defensive primitive behind a paywall (W233 decision rule).

## Held decisions (owner)

1. Approve/adjust v0 numbers and band edges.
2. Hosted/SaaS posture — out of scope for v0; klh-remote is self-host
   only until the GitHub push lands (existing owner-held decision).
3. Whether `blam` ships in Core public or moves reference-only.
