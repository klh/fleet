# Fleet entry points + import graph — W1249 map

Read-only architecture map (restructure proposal Phase 1,
docs/restructure-proposal-2026-10-23.md, Amendment B SAFE NOW: no runtime
changes). Every number here is regenerable in one command from the
import-graph lib; the guard pins the law that keeps it true. (W1302.4: the
lib moved to `packages/suspenders/hooks/lib/import-graph.ts`; the
tests/helpers path is its re-export shim — both import paths work.)

Regenerate:

    bun -e 'import {scanFleet, reachIns, klhEdges} from "./tests/helpers/fleet.import-graph.lib.ts";
    const fleet = await scanFleet(process.cwd());
    console.log(new Map([...reachIns(fleet), ...klhEdges(fleet)].reduce((m, e) =>
      m.set(`${e.sourcePkg}`, (m.get(e.sourcePkg) ?? 0) + 1), new Map())));'

## Packages and entry points

| Package | Role | Entry points |
| ------- | ---- | ------------ |
| belt | local-LLM kit: router, swarm, bench | `bin/router-shim.ts` :4000 (Anthropic-wire router, complexity-v3) · `bin/cloud-gateway.ts` :4100 litellm transport · `bin/dashboard.ts` :7791 · MLX specialists :8901-:8913 (`bin/registry.ts`) · `bin/m365/serve.ts` |
| buckle | LLM auth gate + proxy | `src/server.ts` :4101 Mac spoke / :4111 desktop hub · `bin/preflight.ts` |
| suspenders | control plane | store :7794/:7795/:7796 (`hooks/bin/store-server.ts`) · fleet board :7799 (`hooks/bin/fleet-board.ts`) · CLIs work/coord/dispatch/oracle (`hooks/bin/*.ts`) · fleet-loop cycle (`hooks/lib/fleet-loop/*`) · launchd `com.suspenders.fleet-pulse` |
| speedy | developer env layer | `bin/install-fleet.ts` · hooks (statusline, bash-gate, swarm-watch, approve-skill) · `src/provider-config.ts` |
| local | service front | Caddy `.local` registration · `scripts/build-lit.ts` |
| local-llm | MLX swarm kit | `swarm.ts` status/supervise · `spawner.ts` |
| blam | agent-mishap benchmark | `bench/` arena harness · test fixtures |
| decant | vendored snapshot @ v0.11.0 | upstream-owned bytes; `fleet/` adapter layer is the ONLY fleet-face |
| telemetry | observability | NO manifest — buckle reaches in via `../../telemetry/src/*` (see graph below) |

## The import graph (2026-10-24, commit 07a822c1)

**Legal surface — declared @klh edges** (imports via package names):

| From → To | Edges |
| --------- | ----- |
| belt→blam | 3 |
| blam→belt | 1 |
| blam→buckle | 1 |
| blam→suspenders | 4 |
| buckle→blam | 3 |
| suspenders→blam | 3 |

**Banned surface — relative reach-ins** (112 edges, ratcheted shrink-only by
tests/fleet.import-law.guard.test.ts; close an edge = delete its pin line):

| From | Edges |
| ---- | ----- |
| suspenders | 52 |
| belt | 32 |
| buckle | 15 |
| blam | 7 |
| local-llm | 4 |
| decant | 1 |
| local | 1 |
| telemetry | 0 |
| (repo) | 0 |

## Law

- Cross-package imports ride package names (`@klh/*`); relative reach-ins are
  the ratcheted debt set above. Runtime imports need `dependencies`,
  test/content imports deps-or-devDeps — phantoms fail the guard.
- kernel imports nothing in fleet (vacuously enforced until
  packages/kernel lands — W1246 carries the kernel creation).
- Enforced by tests/fleet.import-law.guard.test.ts + W649's
  tests/cross-package-imports.test.ts (the two scanners cross-verify).
