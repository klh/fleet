# Decision W1238.3 — strict-install conformance (2026-10-23)

Lane autow1238-3-p98b319584008df14, item W1238.3. The re-review (W1238)
named seven strict-install findings; each is closed or recorded as a
deviation here.

## 1. telemetry has no package.json — CLOSED

`packages/telemetry/package.json` created (`@klh/telemetry@2.0.0`, private,
`type: module`, no dependencies). It is a workspace member via the root
`packages/*` glob, ships in the harness payload (sync-harness SOURCE_PATHS +
manifest strip-list + a scoped `node_modules/@klh/telemetry` link in the
installed stage), and joined the CI test matrix. Verify: `bun install
--frozen-lockfile` green; `bun test packages/telemetry/test/` green.

## 2. decant is workspaces-excluded — DEVIATION

decant is vendored upstream (dosu-ai/decant, Apache-2.0) with its own
`bun.lock`, `.bun-version`, `packageManager: bun@1.4.2`, and 23 upstream
version ranges. Workspace membership would dissolve that independent
lockfile into fleet's root graph and rewrite upstream-shaped manifests on
every fleet install. It stays excluded (root workspaces `!packages/decant`)
and installs/tests standalone. Fleet-side integration points
(`decant/fleet/*`) ride the W1081-style payload layout and are covered by
the relative-import allowlist guard (#3).

## 3. Cross-package relative imports — CLOSED (guard + seam) / DEVIATION (edges)

Full census: **52 production files** reach into another package by relative
path — the re-review named 4; the rest is deliberate fabric. Actions:

- **Converted to the declared graph** (named `@klh/*` imports + declared
  `workspace:*` deps, verified by the W649 guard): the shared-library seam —
  `buckle/src/gov/admin.ts`, `buckle/src/adapters/errors.ts`,
  `suspenders/hooks/lib/servicemon.ts` → `@klh/telemetry`;
  `suspenders/hooks/lib/stack-config.ts` → `@klh/buckle` (type-only). The
  installed stage resolves them through scoped `node_modules/@klh/*` links
  (sync-harness now links belt, buckle, telemetry beside blam).
- **Deviation for the remaining 48 files**: belt/bin is a flattened runtime
  closure (`scripts/belt-bin-overlay.ts`) and several modules do runtime
  path arithmetic on belt/bin files (`service-inventory.ts` reads
  `registry.ts` via `import.meta.url`). The harness payload preserves the
  `packages/` layout under `.harness/`, so the relative depth is an install
  invariant in checkout AND artifact — proven every push by the CI
  `artifact-roundtrip` job, which builds every installed entrypoint.
- **Teeth**: `tests/cross-package-imports.test.ts` pins the full
  file → reached-packages allowlist with EQUALITY. A new cross-package
  relative import fails CI until it converts to a named import or is pinned
  here consciously; a removed edge must update the pin.

## 4. 43 floating version ranges — CLOSED (20 fleet-owned) / DEVIATION (23 decant)

Every fleet-owned range is pinned to its locked version: suspenders 15
(`@clack/prompts 1.8.1` … `zod 4.6.5`), buckle 4 (`@types/bun` `latest` →
`1.4.2`), belt 1 (`lit 3.3.3`). Root lock re-resolved and frozen-verified.
decant keeps its upstream ranges (deviation under #2).

## 5. engines are floors, not pins — DEVIATION

`engines` expresses a compatibility floor (`bun >=1.2`); the exact
toolchain pin lives in `packageManager` (#6) — the standard split of
concerns in the Node/Bun ecosystem. Pinning `engines` to an exact version
would misrepresent real compatibility (the code runs on 1.2+) and fight CI's
floating bun.

## 6. No packageManager — CLOSED

`"packageManager": "bun@1.4.2"` added at the repo root and in all eight
fleet-owned package manifests, matching the runtime bun (1.4.2) and
decant's pin. Residual: CI's setup-bun still floats `latest`; the pins bind
local and payload installs, and a future CI change can source the version
from the manifests. `packages/buckle/bun.lock` is vestigial — bun resolves
any install inside the workspace to the root lock (verified: identical
graph from `packages/buckle`), and the CI frozen gate therefore runs
against the root lock.

## 7. Missing CI artifact-roundtrip job — STALE (already landed)

The `artifact-roundtrip` job exists (ci.yml, W649): isolated-HOME install,
build of every installed entrypoint FROM the prefix, dispatch-shim
resolution check, and a checkout-path sweep of the installed artifact. The
imports-guard comment citing it is accurate.
