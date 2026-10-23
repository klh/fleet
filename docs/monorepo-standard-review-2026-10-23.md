# Fleet monorepo standard review — 2026-10-23 (W1238)

Checklist: `docs/paas-engineering-standard-2026-10-23.md` — the house
standard (untracked in the main checkout at review time; commit it before
the gap items are picked up, or the checklist stays unversioned).
Tree: `suspenders/W1238` at `74605857` (same commit as `main`).
Read-only audit lane: scripted census + targeted reads; no code changed.

Method: scripted census over all 9 packages (manifests, lockfiles, test
files, UI-law patterns, zod imports, dependency ranges) plus targeted reads
of CI, law guards, installer CI assertions and deploy templates. The
standard's own review-log corrections (npm-installs, exact pins, Playwright
only) are part of the checklist.

## Disposition of the 2026-10-05 findings

Nine of ten 10-05 findings are closed; the cutover held.

| 10-05 finding | State at 74605857 | Evidence |
| --- | --- | --- |
| P0-1 root CI dead | Fixed | root `.github/workflows/ci.yml`, 9 jobs (test matrix, laws, imports, runtime-sqlite, release-manifest, docker-e2e, entrypoints, installer) |
| P0-2 installed harness cannot resolve blam | Fixed | installer CI job asserts `$HOME/.claude/hooks/suspenders/blam/src/condense/tiers.ts` (W422.14) |
| P1 hub-compose defaults to archived repos | Fixed | `HUB_FLEET_REPO_URL:-https://github.com/klh/fleet.git` default in hub-compose.yaml |
| P1 workspace split-brain | Mostly fixed | all 7 original packages manifest as `@klh/*`, root `bun.lock`, `workspace:*` deps, W649 import guard; residuals → W1238.3 |
| P1 tracked runtime state | Fixed | no `.fleet/` state files in the index |
| P1 docs drift | Fixed | per-package AGENTS.md (decant/telemetry excepted) + docs-canonical drift guard |
| P1 versioning gap | Fixed | 54 git tags through v2.0.0, root CHANGELOG.md, package versions aligned at 2.0.0 |
| P2 machine-state leaks | Fixed | no hard-coded home paths in tracked code; `homedir()` throughout |
| P2 innerHTML in board-html | Fixed | board-html rewritten; textContent/createElement only; UI-law guard with allowlist |
| P2 stale dirs examples/pages/spikes | Still present | `packages/suspenders/{examples,pages,spikes}` — folded into W1238.6 |

## Principle-by-principle

Status words: CONFORMANT / PARTIAL / GAP. Packages: fleet is the repo root;
decant, local and telemetry are grouped as "others".

### P1 Native first

CONFORMANT stack-wide, one documented deviation. Platform APIs everywhere
(Bun.serve, Bun.spawn, Bun.Glob, node:fs, URLPattern-free simple routing);
no framework layers over them. Deviation: Lit is vendored (offline LAN) and
belt/suspenders vendor other bundles under lib/vendor; the standard's review
log corrected vendored Lit to exact-pinned npm lit. Deliberate, documented
in AGENTS.md — record it as an accepted deviation, not a gap item.

### P2 Boring and inspectable

PARTIAL. Small hand-written modules throughout; no framework adoption.
Deviation: 43 floating dependency ranges (`^`/`~`) across 4 manifests
(decant 23, suspenders 15, buckle 4, belt 1) where the standard wants exact
pins everywhere. Tracked in W1238.3.

### P3 Composed, never monolithic (1500 cap, 1200 stop)

GAP — the one place CI is red today. `packages/decant/src/ingest.ts` is
1981 lines vs the 1500 hard cap; `tests/law-guards.test.ts` ("no tracked .ts
exceeds the 1500-line law") FAILS at 74605857, so the `laws` CI job is red
on main. The 1200 stop-and-decompose rule is not adopted anywhere. Tracked:
W1238.1 (make the guard green), W1238.6 (1200 band + stale dirs).

### P4 Stateless by default

CONFORMANT (bounded check). Pure modules, gate mediators, adapters as
functions of inputs; state concentrates in the graph DB and machine config.
No leaf-state violations surfaced in the census or guards.

### P5 Schema first (zod)

GAP. zod is imported in exactly 4 suspenders files; buckle, belt, decant,
blam, speedy, local, local-llm and telemetry import it zero times — wire
shapes are hand-typed. Largest single-principle gap by file count.
Tracked: W1238.4 (adopt or deviate).

### P6 Events up, data down

CONFORMANT where it applies. board-html client chunks render via
textContent/createTextNode under the UI-law gate and announce custom
events to mediator handlers; hooks flow the same way (announce + mediator).
No forked-variant violations surfaced.

### P7 ONE test framework (@playwright/test, incl. load)

GAP — the largest systemic divergence. 721 `*.test.ts` bun:test files
across 9 packages, zero playwright.config.ts, zero `*.e2e.ts`. Load story is
the docker-e2e CI job, not a load project. Either migrate (large) or record
a documented deviation. Tracked: W1238.2 (decision item).

### P8 Semantic errors, one handler

PARTIAL. Real per-service error surfaces exist (buckle adapters/errors.ts,
gate exit-code taxonomy, oracle exit-code contract), but there is no shared
kind set and nothing guarantees kinds flow unchanged service → HTTP → UI.
Tracked: W1238.5.

### P9 Good HTTP citizen

PARTIAL. The gate and router do shed/retry/timeout, and the uncapped
Retry-After floor bug was fixed; but no problem+json anywhere, no
Idempotency-Key handling, no shared conditional-request (ETag/If-Match)
helper, and the retry rules live in code, not one place. Tracked: W1238.5.

### P10 Every folder a package, strict install

PARTIAL with a proof hole. All 7 original packages manifest as `@klh/*`
with `workspace:*` internal deps and the W649 guard checks name-imports
against declarations. Holes: telemetry has no package.json (uninstallable,
invisible to the W649 guard); decant is workspaces-excluded; production
relative imports still cross packages (suspenders/hooks/lib/oracle-legs.ts
and service-inventory.ts → `../../../belt/bin/*`; buckle/src/gov/admin.ts
and adapters/errors.ts → `../../../telemetry/src/*`); engines are floors
(`bun >=1.2`), not pins; packageManager only in decant. The W649 guard's
comment cites a "CI artifact-roundtrip job" that does not exist in ci.yml —
nothing proves a package installs into a scratch dir outside the repo.
Tracked: W1238.3.

### P11 Same shape everywhere

GAP (deliberate). No per-package tsconfig except buckle and decant (5 of 7
lack one); folder shapes differ per package (hooks/, scripts/, bin/, src/,
e2e/); test files are `*.test.ts`, not the standard's `<ns>.<thing>.<role>`
naming. Much of this is coherent-for-bun rather than accidental; treat the
matrix row as a deviation record, not a work order. Partial credit: engines
and manifest fields align; the docs-canonical guard keeps AGENTS/CLAUDE in
sync.

### P12 Config off-repo

CONFORMANT — fleet's strongest row. `stack.example.yaml` placeholders only;
real hosts/keys in 0600 machine config; scrub gate + machine-local
denylist; secrets minted on target. Minor: `engines` floors are not pins
(W1238.3).

## Gaps → tracked follow-ups

All minted under W1238 as parent:

- W1238.1 (P1) decompose decant ingest.ts past the 1500 law — laws CI red.
- W1238.2 (P1) test-framework decision: bun:test → @playwright/test or
  documented deviation.
- W1238.3 (P2) strict install: telemetry+decant manifests, kill relative
  cross-package imports, exact pins, artifact round-trip CI job.
- W1238.4 (P2) schema-first zod adoption or deviation.
- W1238.5 (P3) shared semantic-error kinds + HTTP-citizenship kit.
- W1238.6 (P3) 1200-line stop band sweep + retire examples/pages/spikes.

## Limits

Bounded, not exhaustive. The standard doc was read via an auto-clamped
head+tail pass (~85%; the elided middle is design-system internals — the
principles and enforcement tables were fully read). UI rows for local, blam
and speedy are structural judgments from census + law guards, not
line-reads. No deploy or install was executed; no browser pass needed (no
UI deliverable). The vendored-Lit and worktree-inside-repo patterns are
documented fleet laws that contradict the standard's corrections — they are
owner-level deviation decisions, flagged here, not unilaterally judged
failures.
