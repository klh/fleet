# W688.3 — fleet-side hub-entry gov wiring: landing record

Status: delivered (no new code needed — the deliverable landed 2026-10-15 at
`71c26220` as W775.2 phase 1, which ordered "wiring first (W688)" before its
entitlements/federation phases). This record closes the duplicate item with
verification evidence.

## What the item asked

- buckle `boot()` passes the loaded overlay module's gov factories
  (`createSpokeEnrollment` / `createHubEntitlements` / `createUsageIngest`)
  to `startServer` auth opts.
- `hubctl render` + `hub-compose.yaml` carry `KLH_OVERLAY_DIR` /
  `KLH_OVERLAY_ALLOW` / `KLH_OVERLAY_SHA256` (env only, config-over-code).

## Where it lives

- `packages/buckle/src/gov/overlay-loader.ts` — `GovSeamFactories` +
  `overlayModuleGovSeam()` (absent export = solo posture; malformed surface
  throws at boot).
- `packages/buckle/src/server.ts` — `boot()` extracts the gov seam from the
  loaded overlay and hands it to `startServer` auth opts (provider-less
  entries stay on honest-501 discipline).
- `packages/suspenders/deploy/hubctl.ts` — `HUB_KLH_OVERLAY_DIR/SHA256/ALLOW`
  rendered from the hub profile.
- `packages/suspenders/deploy/hub-compose.yaml` —
  `KLH_OVERLAY_DIR/SHA256/ALLOW` wired from those env knobs.

## Verification (2026-10-19, this worktree)

`bun test` over `gov-overlay-loader` / `gov-overlay-seam` / `gov-hub-seam` /
`gov-federation-e2e` (31 pass) and `hubctl-overlay` /
`hub-compose-hardening` / `gov-gate` / `gov-units` (39 pass) — 70 pass, 0
fail. Solo posture unchanged.
