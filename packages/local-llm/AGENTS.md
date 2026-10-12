# AGENTS.md — local-llm (MLX swarm kit)

Dual-homed kit: source = `packages/local-llm`, runtime home =
`~/.claude/local-llm` (the live swarm's source of truth). This file is the
subtree's canonical law; the fleet-wide shape rules live in
`docs/layout-convention.md`.

## The flat overlay contract (W556 — documented, never changed)

- Files stay FLAT in the package root: no `bin/`, `src/`, or `test/` dirs.
  The runtime home overlays these files verbatim, so any rename here forks
  every deployed host (Mac spoke + hubs). A rename is a deploy-surface move
  needing owner GO — never a refactor wave.
- The installer never clobbers a present runtime copy (W556). `swarm.ts` is
  the one kit file that may refresh a present copy (serve-supervisor
  bootstrap). belt-owned sources survive here only as re-export shims
  (`registry.ts`, `spawner.ts` → `packages/belt/bin/`): the port↔model
  registry and the spawner lifecycle have ONE home, belt's.
- Shipping is an explicit allowlist + closure walk, never a copy-all:
  `packages/suspenders/install.sh` copies named kit files when absent, and
  `scripts/belt-bin-overlay.ts overlay` ships the router-shim import
  closure from `belt/bin` (W661) with a `smoke` verb that spawns the
  flattened home on a scratch port and requires /health 200. `*.test.ts`
  appears in no copy path — tests never ship.
- New kit file → add it to the install.sh allowlist or it never reaches the
  runtime home. New import edge from a shipped file → it must ride the
  overlay closure (or the allowlist), or the smoke check fails the install
  loudly instead of looping launchd revives on :4000.

## Tests

Co-located beside their modules (`*.test.ts`, flat — W669 wave-5 audit
verdict: the co-location already holds, no test/ mirror). Run:
`bun test packages/local-llm/`. Two are source-contract tests that read
source as text: `spawner.test.ts` pins the kit↔belt re-export shape plus
the install.sh flatten contract; `swarm-ownership.test.ts` pins swarm.ts
ownership. When install.sh or belt/bin changes shape, update the contract
assertions in the SAME commit.

## Neighbors

belt owns the registry and the :4000 router; suspenders owns install +
overlay tooling. The tier manifest (`tier.json`) is machine config,
re-emitted per install — never committed.

## Local cache laws (W458.4)

- Warm workers when justified (keepwarm + the tier manifest resident set); a
  cold worker must start correctly from the model artifact ALONE — weights on
  disk, never a borrowed live cache.
- KV-state transfer between workers only after engine compatibility is
  verified; there is no correctness dependency on live GPU cache — every
  worker recomputes from its artifact, so a cache miss degrades speed, never
  answers.
- Cache/reuse data is routing and accounting context only; it never gates a
  request. Boundary definitions live in buckle `src/cache-boundary.ts`.
