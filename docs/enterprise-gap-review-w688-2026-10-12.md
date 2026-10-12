# Enterprise-tier gap review — W688 (2026-10-12)

Re-run of W683 (died pre-wiring). Auditor: lane autow688 (W688).
Evidence: the enterprise checkout `klh/fleet-enterprise` (main worktree on
`suspenders/W233` @ 60b250e, plus worktrees `.worktrees/W233.2` @ 8f119f5
and `.worktrees/W233.4` @ 1d206ff), fleet main (seams + strips), the work
graph, and `docs/enterprise-posture-audit.md` (W233.5 state, 2026-10-11).
IKEA seat/partner intel was read from coord facts `finding.ikea-*` only —
none of it is committed here; the enterprise requirements below are the
generic shape (auth on product surfaces, secrets in runtime config, audit
trails), not IKEA content.

## State of the tier (verified 2026-10-12)

Origin `github.com/klh/fleet-enterprise` exists (W422.9/W422.1 DONE), but
**origin/main = ac272bc — pre-overlay structure only**. Every overlay move
since lives on unpushed local branches, each pinning a different fleet
ref. Nothing is integrated; nothing is tagged past `stack-5234813`.

| Enterprise surface                   | State      | Where it lives                                     |
| ------------------------------------ | ---------- | -------------------------------------------------- |
| buckle-remote spokes (W233)          | CODE       | enterprise branch `suspenders/W233` @ 7628c84      |
| buckle-remote entitlements (W233.1)  | CODE       | enterprise branch `suspenders/W233` @ 60b250e      |
| buckle-remote usage ingest (W233.2)  | CODE       | enterprise branch `suspenders/W233.2` @ 8f119f5    |
| buckle-remote manifest/CR (W233.3)   | **MISSING**| no enterprise branch; only the fleet strip landed  |
| belt-remote federation-cr (W233.4)   | CODE       | enterprise branch `suspenders/W233.4` @ 1d206ff    |
| belt-remote peers profile (W358)     | MERGED     | enterprise main ac272bc (2aad16f, d06eae6)         |
| suspenders-remote                    | CONFIG ONLY| hub-profile.yaml (OIDC/admin = base code, config)  |
| W235 overlay packaging               | **MISSING**| no `manifest.json` in buckle-remote; `createAdaptation` exists only in fleet's test fixture |
| hub-entry gov wiring                 | **MISSING**| no production entry passes `auth.{spokeEnrollment,hubEntitlements,usageIngest}`; zero `KLH_OVERLAY_*` refs in hubctl/hub-compose |

## The central gap: no production wiring

`packages/buckle/src/server.ts` (`main()`/`boot()`, ~:339-388) loads the
overlay module but consumes only `createAdaptation`; the gov factories the
enterprise overlay exports (`createSpokeEnrollment`,
`createHubEntitlements`, `createUsageIngest`) are `startServer` opts that
**no entry ever passes**. Nothing sets `KLH_OVERLAY_DIR` /
`KLH_OVERLAY_ALLOW` / `KLH_OVERLAY_SHA256` in hubctl or hub-compose
(zero matches). Consequence: even a flipped hub serves honest 501s on
enroll/usage/entitlements/manifest — the flip makes overlay code PRESENT,
not WIRED. (The mission's namesake gap; W683 died before recording it.)

## Deploy gate (per docs/overlay-flip-gate-w233-5-2026-10-11.md)

- Fleet main already carries the W233.2/W233.3 strips (daf35b2, 16c1cd8,
  both on main) — **any stack-version bump past `stack-5234813` breaks
  public-hub serving** (enrollment/manifest/CR routes 501) until both
  hubs flip to the overlay origin.
- NAS: config flipped and renders clean; blocked on transport only (CF
  526 + ssh dark from this LAN, NEED_DECISION #30282; W493.3 + W632
  FAILED with a documented retry path).
- Desktop: NOT flipped; Docker daemon down; owner GO pending (flip-gate
  doc's proposed `repos:` block, render-proofed byte-equivalent).

## Completion plan (minted as W688.x children)

1. **W688.1** — Integrate + publish: merge the three overlay branches
   into enterprise main, reconcile the single root fleet pin to fleet
   main (all seams present there), `bun test` green at the enterprise
   root, push origin main.
2. **W688.2** — W233.3 overlay side: `buckle-remote src/gov/manifest.ts`
   implementing `ManifestCrProvider` (hub-seam.ts:174) + CR DDL in the
   overlay schema fn + re-homed e2e + pin bump.
3. **W688.3** — Fleet-side hub-entry wiring: `boot()` hands the loaded
   overlay module's gov factories to `startServer` auth opts (provider-
   less solo unchanged, 501 discipline); hubctl render + hub-compose
   carry `KLH_OVERLAY_DIR/ALLOW/SHA256` (env plumbing only,
   config-over-code).
4. **W688.4** — Enterprise W235 packaging: `manifest.json` (name,
   protocol handshake, relative entry, entry sha256, endpoints
   allowlist) + optional `createAdaptation` for buckle-remote.
5. **W688.5** — Desktop flip execution (after owner GO on the proposed
   `stack.yaml` `repos:` block + Docker daemon up); NAS stays on the
   existing W632 item (route restore #30282) — no duplicate lane.
6. **W688.6** — Stack bump + end-to-end verify AFTER both flips: new
   overlay tag carrying all moves, `stack.yaml` version bump, hubctl
   status both hubs, and a real enrollment walk (hub mints a code, spoke
   redeems, registry row + heartbeat visible) proving federation routes
   stopped 501ing.
7. **W688.7** — Phase-2 classification decisions (decision records, not
   strips): suspenders spoke-side federation (pull/report/peers/board),
   teams/ceilings DDL co-existence, and the W231 correction below.

## Classification correction

`docs/enterprise-posture-audit.md` row "W231 ALREADY OVERLAY" is wrong:
the W231 hub admin GUI landed in FLEET (`/console/hub` on the belt board,
5c9c54c4; the suspenders-remote profile comment "base code, W231" is
accurate). Keep-public vs overlay-strip for W231 joins W688.7's decision
set; the audit row should be corrected when that decision lands.

## Requirements coverage (auth / secrets / audit)

- Auth on product surfaces: per-surface keys + scopes + OIDC are base
  code (W188/W191/W231/W233 gate) — config-only in the overlays; the
  missing piece is the wiring above, not the primitives.
- Secrets in runtime config: `hub.example`/placeholder law holds in all
  three profiles; hubctl renders from `~/.config/klh/stack.yaml`. No
  violations found.
- Audit trails: KeyStore `recordAuthEvent` on issuance; `admin_audit`
  into governor.db via the W231 plane. Enterprise-grade trails (env
  isolation, enrollment actor provenance) ride the existing surfaces.
