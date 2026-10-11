# Enterprise-posture audit — W233

The public fleet monorepo carries hub/enterprise surfaces that a solo
install never exercises. Per finding.auth-posture-split, public keeps
defensive security (crypto, gate, binds, allowlists, env-ref handling);
hub-only code moves to the private overlay tier (klh-remote,
`/Volumes/Sensitive/github/klh/fleet-enterprise` on disk). Every move =
one overlay export + one public seam use, no dead code left public.

## Decision rule

A surface moves iff **both** hold:

1. **Zero solo reach**: no solo-posture path (default install, no hub
   profile, no federation peers, self-report opt-in never granted)
   reaches it; absent it, solo behavior is identical.
2. **Not defensive**: it mints, inventory-tracks, meters, or
   entitlement-maps — it does not verify, bind, allowlist, or degrade
   honestly.

## Classification (evidence: import graph, 2026-10-11 tree)

| surface | verdict | evidence |
| --- | --- | --- |
| `buckle/src/gov/keys.ts`, `scopes.ts`, `jwt.ts` (validator seam), `budgets.ts`, `slots.ts`, `schema.ts` (governance core) | **KEEP** (defensive/solo-used) | gate + admin key API mint per-lane `bksk_` keys — the solo dispatch flow (AGENTS.md); jwt.ts is the IdP-neutral validator seam |
| `buckle/src/gov/federation-signing.ts`, `handlers.ts /.well-known/jwks.json` | **KEEP** (defensive crypto) | W193 manifest signing + JWKS serve; finding.auth-posture-split names signing a public crypto primitive |
| `buckle/src/gov/middleware.ts` gate + admin routes | **KEEP** (defensive) | W188/W193 gate semantics; loopback-bind law; 501 discipline |
| `buckle federation-spokes.ts` (enrollment codes, registry, heartbeat touch) | **MOVED (W233)** | imported only by admin.ts + federation.ts hub routes; zero solo reach; mints + inventories |
| `buckle federation-manifest.ts` (policy manifest + CR queue content) | **FOLLOW-UP** | hub-serving content; move rides the same seam pattern once the overlay carries the CR queue DDL (schema.ts federation CR tables are the residual public DDL) |
| `buckle federation-usage.ts` (hub ingest + rollup DDL) | **FOLLOW-UP** | hub-side ingest only; spoke POST side is suspenders-side and stays |
| `buckle federation-entitlements.ts` (hub menu) | **MOVED (W233.1)** | single import site federation.ts (buildModels) — moved to klh-remote buckle-remote `src/gov/entitlements.ts` (`createHubEntitlements`), route rides `auth.hubEntitlements`, honest 501 solo posture; ceilings read-side stays public |
| `buckle federation-spokes.ts` residue (dead module file, no importers post-W233) | **REMOVED (W233.1)** | the W233 move left the file behind with zero importers; deleted — no dead code left public |
| `buckle federation.ts` hub routes (enroll/usage/entitlements/CR handle dispatch) | **PARTIAL (W233/W233.1)** | enroll + heartbeat ride the spoke provider seam (W233); entitlements rides the menu seam (W233.1); usage/CR dispatch follows each module's move |
| `belt bin/federation-cr.ts` (hub-admin CR originate CLI) | **MOVED (W233.4)** | re-homed to klh-remote belt-remote `bin/federation-cr.ts` (CLI + test, code verbatim) — hub-admin operator surface by its own header law; the `/federation/cr` buckle gate seam it posts to stays public (defensive); public belt dropped bin + test with zero importers left; belt route-policy/remotes stay public (finding.auth-posture-split) |
| `suspenders hooks/lib/federation.ts` + `bin/federation-pull.ts`, `federation-report.ts`, `federation-peers.ts`, `board/routes-federation.ts` + `bin/federation-usage-html.ts` | **KEEP (phase-2 review)** | spoke-side pull/report (owner-scenario client of defensive policy distribution); peers = W362 hub-to-hub propagation (belt-remote profile surface); board panel is hub-admin read view — phase 2 candidates once the buckle-side moves land |
| `belt local/_http._tcp advertise + _klh-llm._tcp browse` | **KEEP** (solo-used) | belt.local dashboard advertisement is the solo LAN face; remotes browse is the owner's multi-machine LLM routing (finding keeps belt remotes public) |
| `suspenders hooks/lib/hub-locate.ts` (`_klh-hub._tcp` browse chain) | **KEEP** (defensive resolver) | env → .prefer → registry → mDNS → **null-degrade, never a silent wrong hub**; solo-inert but defensive-adjacent; the hub ANNOUNCE side does not exist in public code (only browse) |
| W231 (multi-user token issuance/revocation + admin GUI) | **ALREADY OVERLAY** | re-targeted at klh-remote per finding; plugs into the W233 provider seam |
| teams table + ceilings (W141 multi-user budgets) | **PHASE-2 REVIEW** | multi-user surface; read-side only in public (teamCeilings in federation.ts); DDL is shared governance schema (defensive) — strip is a schema co-existence decision, not a file move |

## The executed move (W233 reference pattern)

`buckle federation-spokes.ts` → klh-remote `packages/buckle-remote`:

- **Overlay export**: `createSpokeEnrollment(db)` — the module + its two
  tables (`federation_spokes`, `federation_enrollment_codes` DDL moved to
  the overlay hub schema) + the real e2e (moved
  gov-spoke-enrollment.test.ts).
- **Public seam**: `src/gov/hub-seam.ts` (contract types +
  SpokeEnrollmentProvider) — federation.ts/admin.ts route through
  `gov.federation?.spokes`; provider-less = honest 501
  buckle.no_federation + no-op heartbeat. startServer `auth.spokeEnrollment`
  is the injection point; server buildDeps passes it to Federation.
- **No dead code public**: spokes module, its tables, federationDb()
  helper, and the e2e test all left public; DDL comment marks the move.
  (W233.1 residue fix: the module FILE itself lingered with zero
  importers — deleted in W233.1.)

## The second move (W233.1 — entitlements)

`buckle federation-entitlements.ts` → klh-remote `packages/buckle-remote`
`src/gov/entitlements.ts`:

- **Overlay export**: `createHubEntitlements(pool, tags)` — pure mapping
  (no tables), the W154 buildModels verbatim; the echo-menu e2e re-homed
  as the overlay's `test/entitlements.test.ts`.
- **Public seam**: `EntitlementModel` + `HubEntitlementsFactory` joined
  `SpokeEnrollmentProvider` in `src/gov/hub-seam.ts`; federation.ts
  entitlementsRoute 501s provider-less (solo posture); startServer
  `auth.hubEntitlements` is the injection point. Team ceilings read-side
  stays public (shared governance schema, phase-2 strip decision).
- **Pin**: overlay pins fleet at the W233.1 seam head (github resolution
  lands with the fleet ref push; until then the seam branch checked out
  at the dep — the lane store sync replicates it and the overlay suite
  ran green against it, 9/9).

## Migration ladder (deploy-order gate)

Hubs run public fleet at the stack version (hubctl renders
HUB_FLEET_REF). Strips land on main BEFORE hubs adopt the overlay →
public hubs lose hub-serving (spoke pulls still authenticate and reach
the manifest/CR routes, but enrollment routes 501, registry stops
updating). Therefore:

1. Overlay export lands (this move, pins fleet at the W233 head).
2. Hubs flip `stack.yaml` repos to the overlay origin + ref (hubctl
   overlay mode — repos.ref required, GH002-safe) BEFORE the stack
   version bump that carries later strips.
3. Follow-up moves (manifest/usage/entitlements) each repeat the seam
   pattern; a follow-up that strips the manifest pull SERVING breaks
   public-hub spoke pulls — sequence behind the overlay flip.

The 501 discipline keeps every transitional state honest (degraded
surface, never a 500).

## Verification

- buckle suite 457 pass / 0 fail with the entitlements seam + strip
  landed (W233.1); sibling W233's overlay e2e (enrollment + registry +
  heartbeat + CR walk) verified green against the same seam-head store
  sync — 9/9 overlay tests pass.
- Seam contract test: gov-hub-seam.test.ts (501s provider-less, full
  mint→redeem→list via stub through the real routes; W233.1 adds the
  entitlements seam cases — solo 501 + stub menu through the real route).
- Overlay e2e (enrollment + registry + heartbeat + CR walk) re-lands as
  the overlay's own test against the pinned fleet base.
- W233.4: belt `bin/federation-cr.ts` + `test/federation-cr.test.ts`
  dropped public with zero remaining importers (repo-wide rg); re-homed
  as belt-remote `bin/federation-cr.ts` + `test/federation-cr.test.ts`
  (code verbatim from `export interface CrArgs` on, header re-homed),
  overlay suite 2/2 green against the family base 7628c84.
