# packages/kernel — fleet primitives, the bottom of the graph

The dependency-free core (W1254, restructure-proposal Phase 1): kernel
imports NOTHING in fleet — no relative imports into belt/suspenders/buckle/
local/decant/local-llm/telemetry, no `@klh/*` imports, no zod (Amendment C).
Every package MAY import kernel (fleet-seams first); the direction rule is
the W1249 import-direction lint guard.

## Law

- **Imports nothing in fleet.** src/ may import node builtins only. Test
  files may read twin files as BYTES (`readFileSync` — never module imports
  of fleet code).
- **Zod-free** (Amendment C): schema-first codecs stay out of the kernel.
- **Proven duplicates only.** A module enters only with proven duplicate
  instances (byte-twins or a proven instance of the same semantics) and
  twin-parity tests pinning promotion fidelity. No speculative abstractions.
- **1500-line cap + 1200 near-cap decompose** per repo law; files are named
  `kernel.<thing>.<role>.ts` (naming law for new files).
- **Belt/suspenders/buckle/local/decant/local-llm may import kernel.**
  Migration is package-by-package (per-package migration items) — until a
  face migrates, its current twin keeps its bytes pinned by the parity
  tests in `test/`.

## Modules

| module | source (proven duplicate) | parity test |
| ------ | ------------------------- | ----------- |
| exec (run/have/lines) | promote `suspenders/hooks/lib/run.ts` (the "ONE way" exec wrapper) | `test/kernel.twin-parity.test.ts` byte-pins run.ts |
| atomic (atomicWrite0600/modeIs0600) | canonicalized from `board-config.ts` atomicWrite + `export-go-gate.ts` modeIs0600 | `test/kernel.atomic.test.ts` (behavior) |
| env (str/num trim-and-empty) | semantics of servicemon parseRefreshS (trim → empty → fallback) | `test/kernel.env.test.ts` (behavior) |
| theme | byte-twin ×3: `suspenders/hooks/lib/theme.ts` ≡ `belt/bin/klh-theme.ts` ≡ `local/bin/klh-theme.ts` | `test/kernel.twin-parity.test.ts` (4-way byte-equal) |
| host-guard | `suspenders/hooks/lib/host-guard.ts` (belt imports it cross-package — the cycle W1254 breaks on migration); belt model-store imports the kernel face (W1471) | `test/kernel.twin-parity.test.ts` (2-way byte-equal) |
| loopback | `suspenders/hooks/lib/loopback.ts` (the LOOPBACK host list host-guard also carries; buckle egress, belt kv-ship/mcp-server re-derive it); belt hubs.ts imports the kernel face (W1475) | `test/kernel.twin-parity.test.ts` (2-way byte-equal) |
| servicemon | `suspenders/hooks/lib/servicemon.ts` with the W1081 citizenship stamp INJECTED (required `stamp` option — telemetry's `stampResponse` satisfies it, so kernel imports nothing); belt model-store imports it (W1471) | `test/kernel.twin-parity.test.ts` (byte-equal below DEFAULT_BUCKETS modulo the stamp seam + seam behavior) |

## Out of kernel (named in the proposal, deliberately excluded here)

- **registry** — belt/bin/registry.ts is the swarm single-source; no second
  face exists, so no proven duplicate.
- **observation** — the belt/local twins are 6-line re-export shims of
  `local-llm/observation.ts`; the canonical lives in local-llm. Kernel
  would just move the shim, not kill the duplication.
