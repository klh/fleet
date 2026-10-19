# W688.4 record — enterprise W235 packaging verified + drift guard CI-wired

## State found (resume from the W688.6 carry)

- Enterprise `dfc06a1f` (carried by W688.6) landed
  `packages/buckle-remote/manifest.json` (name `buckle-remote`, protocol 1,
  relative entry `src/index.ts`, 64-hex sha256 pin, `endpoints: []`) +
  `deploy/refresh-overlay-digest.ts` (refresh + `--check` drift mode).
- Drift check passes: `bun deploy/refresh-overlay-digest.ts --check` →
  `check: overlay entry digest on-ref`.

## New evidence this lane produced

1. **Real loader × real overlay (first run anywhere)** — fleet's W235
   loader (`packages/buckle/src/gov/overlay-loader.ts`) against the
   enterprise checkout: `PROBE PASS` — manifest parses, protocol 1
   handshakes with `OVERLAY_PROTOCOL_VERSION`, entry digest matches, the
   module imports, `createGovSeam()` yields all four factories
   (spokeEnrollment / hubEntitlements / usageIngest / manifestCr),
   `createAdaptation` absent → `undefined` (valid optional).
2. **Drift guard wired into CI** — enterprise `41c4e4ac` adds
   `deploy/overlay-digest.test.ts` to the root `bun test deploy/` suite
   (9 pass): manifest parses under fleet's `parseOverlayManifest` shape
   law, `protocol === OVERLAY_PROTOCOL_VERSION`, entry digest on-ref.
   The guard fails on ANY unrefreshed `src/index.ts` edit or a fleet
   protocol bump — refresh via the pin-adjacent script, never by hand.
   Lane could not push enterprise main (push-guard: ladder-only); the
   commit rides the merge ladder.

## Decision: createAdaptation stays absent

The W235 contract makes the export optional (absent = solo posture,
fail-closed only on a malformed surface). The enterprise overlay has no
auth surface to adapt — OIDC enforcement is W191/suspenders-remote, and
the gov factories already ride `createGovSeam` (W688.3). Inventing hook
bodies without an owner-approved spec is phase-2 territory (W688.7 →
W695). Absence is the honest state, not a gap; revisit when an
enterprise auth surface exists to expose.
