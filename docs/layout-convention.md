# Fleet layout convention (W669)

The one source for file names, directory taxonomy, and migration waves across
`packages/*`. Serves the standing laws: DRY on the second duplicate, the
1500-line limit, verb-kit CLIs (W651), install-grade syncs, and streams-over-
buffers. Every wave below lands as `git mv`-only commits, one package per
wave, tests green before merge, machine-config/installer surfaces updated in
the SAME commit when an entrypoint moves.

## Target taxonomy by package kind

**Control plane (suspenders)** — the shape is already canonical; waves only
clear debris and true duplicates:

- `hooks/bin/` — one-off CLIs + service entrypoints (every CLI on verb-kit)
- `hooks/board/` — board read/write models, split by route family
  (`routes-*.ts`), one module per API surface group
- `hooks/board-html/` — Lit components (`klh-*.ts`) + vendored `vendor/`
  (build artifacts, committed, rebuilt by `build:vendor`)
- `hooks/coord/`, `hooks/gates/`, `hooks/lib/`, `hooks/watch/` — coordination
  plane, hook gates, shared libs, watch sources
- `scripts/` + `scripts/lib/` — operator-facing tooling (install, hubctl
  support, sync); `deploy/` — compose, services.yaml, healthcheck probes
- `test/` mirrors the source tree; `e2e/` for Playwright

**LLM stack (belt, buckle)** — `bin/` = entrypoints/CLIs, `src/` = importable
modules (buckle already split; belt keeps logic in `bin/` modules that are
imported, not spawned — that is the accepted belt shape, no src/ migration),
`test/` mirrors, `bench/` for benchmark harnesses.

**UI/services (local)** — `bin/` with co-located `.test.ts` stays (small
package, everything ships through one installer); no structural wave.

**Runtime kit (local-llm)** — **stays FLAT by contract**: the runtime home
`~/.claude/local-llm/` overlays these files verbatim (W556: the installer
refuses to clobber the runtime copy; launchd plists + swarm.ts name these
paths). Renames here fork every deployed host. Only test co-location
normalizes (`*.test.ts` may stay beside their modules — they never ship).

## Naming rules

- Files: kebab-case; entry CLIs named for the thing (`work.ts`, `coord.ts`);
  multi-verb kits may carry the family name (`federation-pull.ts`).
- HTML page emitters: `*-html.ts` (the five remaining in `hooks/bin/` merge
  onto the Lit base per W658's children).
- Tests: `test/<mirror>/<name>.test.ts`; bench-harness tests may sit beside
  their harness inside `bench/`; fixtures in `test/fixtures/`.
- Benchmarks docs: ONE `benchmarks.md` per package, decision-grade rows only
  (owner law); `bench-questions.md` merges into it (belt + buckle both carry
  the drift today — wave 4).
- No stray state files in package roots: `*.db`, `*.lock` beyond the root
  bun.lock, scratch `-.` dirs are debris (wave 0).

## Migration waves (blast-radius ascending)

| Wave | Scope                                                                                                                                                 | Risk         | Notes                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 0    | Debris sweep: `packages/buckle/{buckle.db,*-shm,-wal}` (untracked scratch), `packages/suspenders/-` dir, any untracked strays in package roots        | zero         | delete-only; no imports touched                                                                                    |
| 1    | belt: move `bin/*.test.ts` (distill + any siblings) into `test/` mirroring; bench/ co-located tests stay                                              | low          | import-path-only edits                                                                                             |
| 2    | suspenders: audit `scripts/` vs `hooks/bin/` overlap, retire true duplicates (harvest family already owned by W657; verb-kit wave owns the CLI faces) | medium       | each retirement checks consumers (launchd labels + board imports + cron) in the same commit                        |
| 3    | buckle: normalize `bin/` (operator CLIs) vs `src/` (modules) — move any import-only module that lives in `bin/`                                       | medium       | `src/server.ts` is plist-referenced — services.yaml + plists update in the same commit if it moves (it should not) |
| 4    | docs: single-source `bench-questions.md` into `benchmarks.md` per package; cross-pointers instead of copies                                           | low          | md-only                                                                                                            |
| 5    | local-llm: test co-location audit only; document the flat contract in its AGENTS.md                                                                   | zero renames | overlay contract documented, not changed                                                                           |

Waves land in order; a wave is one branch `suspenders/W669.<n>`, one package,
`git mv` + import fixes + tests, closed with `work done --sha` and merged via
the ladder. Hub-affecting entrypoint moves (anything a plist/compose/Caddy
fragment references) additionally flip the owner-visibility broadcast before
merge.

## Explicitly out of scope

- Renames inside `~/.claude/local-llm/` (machine runtime home) — installer
  overlay contract, W556.
- The nine archived pre-monorepo repos — push-dead, nothing to reorganize.
- Any move that changes a Caddy fragment host or a launchd label — those are
  deploy-surface renames needing owner GO (hubctl deploy + restart windows),
  not refactor waves.
