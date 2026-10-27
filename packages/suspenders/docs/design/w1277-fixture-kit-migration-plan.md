# W1277 — W1275 fixture-kit migration plan

Decomposition plan for W1275 (Test DRY at depth): how the four batch children
(W1275.1–.4) carve the ~491 suspenders unit-test files and the 33 `e2e/`
specs, the migration order, and the per-file A/B protocol.

Artifacts:

- `docs/design/w1277-batch-assignment.tsv` — full file → batch assignment with
  duplicate-density columns (mkdtemp / spawnSync / Bun.serve counts per file).
  Advisory: the four batch titles are the contract; this table picks the
  per-file order and resolves stragglers.
- Generator rules are documented here; regenerate the TSV after main moves
  (see "Regeneration").

## Corpus ground truth (measured 2026-10-24 @ worktree W1277, head 12cb374)

- 491 `.test.ts` files flat in `packages/suspenders/test/`; 33 Playwright
  specs in `e2e/`; shared kit code in `test/helpers/` (board-fixture,
  dispatch-harness, cli-e2e-harness), `test/support/hubctl-route-fixture.ts`,
  `e2e/harness.ts`, `e2e/ent-fixture-module.ts`.
- Duplicate idiom density across the corpus: ~`mkdtemp` scratch-HOME/repo
  hand-rolls, 224 files with `spawnSync` CLI runners, 73 files with own
  `Bun.serve({port: 0})` stubs.
- Density leaders (mkdtemp count): install-launchd-stable-repo ×14,
  knowledge-roll ×10, observation-relay ×11, plaid-host-pressure ×9,
  reclaim-sweep ×9, knowledge-sync ×8.

## Batches

| Batch | Item | Scope | Files | mkdtemp | spawnSync | Bun.serve |
| ----- | ---- | ----- | ----: | ------: | --------: | --------: |
| B1 | W1275.1 | board / board-html / usage / console / e2e specs | 80 (+33 e2e) | 75 | 22 | 20 |
| B2 | W1275.2 | fleet-loop, dispatch, lanes, sessions, maintenance | 154 | 257 | 169 | 21 |
| B3 | W1275.3 | gates, coord/consult, stores, hubs, installer, scripts | 168 | 352 | 228 | 40 |
| B4 | W1275.4 | knowledge, work graph, govdb, oracle/doctor | 89 | 193 | 109 | 24 |

### Assignment rules (in order, first match wins)

1. **Import-area votes** — every `from "../<path>"` import in the file votes
   for a batch: `hooks/board*/` → B1; `hooks/lib/{fleet-loop,lane,dispatch,
   session,claude,watchdog,reclaim,rogue,maintenance,prefer,quiet-hours,
   refill,launch,starter,executor,brief,packet,jobslab,plaid}/` → B2;
   `hooks/gates/` → B3; `hooks/lib/{knowledge,kev,wisdom,fact,work,govdb,
   capsule,oracle,doctor,decant}/` → B4. Plurality wins.
2. **Curated overrides** (~67 files whose imports are too thin to vote —
   installer, services, federation, verb-kit, plaid, usage-harvest family…
   full list lives in the generator, mirrored in the TSV rows).
3. **Filename tokens** — the obvious board/lanes/gates/knowledge name
   families. `tab`/`tree` are matched hyphen-bounded so `stable`/`worktree`
   don't leak into B1.
4. Nothing falls through: the last 5 stragglers (consult-*) resolved via
   token B3. Zero UN rows.

`e2e/` belongs to B1 wholesale (its harness.ts ↔ test/helpers/board-fixture
dedupe is B1 scope).

### Known-ambiguous members (boundary rule)

A handful sit near batch lines (work-claim-token, w603-events-shred,
review-lane-proof, bootstrap-lane-metadata). Rule: a file belongs to the lane
whose **lib area it exercises** — when the TSV row and the exercised area
disagree, the lane that owns the area takes it and notes the swap in its
capsule. No file is worked twice; `coord consult` settles genuine collisions.

## Ordering: duplicate density first, within batch

Each batch lane works its TSV rows in `mkdtemp`-descending order (ties by
spawnSync, then filename). The leaders are the whole point: they carry the
most removable duplication per edit. First five per batch:

- **B1**: observation-relay (11), refresh-dashboards (4), theme-sync (4),
  board-drop-files (3), board-idle-timeout (3) — plus the
  `e2e/harness.ts` ↔ `test/helpers/board-fixture.ts` dedupe (~65% copy) as
  B1's first unit.
- **B2**: plaid-host-pressure (9), reclaim-sweep (9), db-backup (7),
  license-audit (7), lane-process-identity (6).
- **B3**: install-launchd-stable-repo (14), install-contract (6),
  scrub-gate (6), ask-gate (5), w869-quality-timing (5). B3 is the largest
  batch (168 files, 352 mkdtemp sites, 40 serve stubs); if the lane
  saturates, the split line is gates+coord vs installer+services — mint a
  fifth child for installer+services.
- **B4**: knowledge-roll (10), knowledge-sync (8), oracle (7), work-mirror
  (7), doctor (6).

## Per-file A/B protocol (zero behavior drift)

Per test file, in this order:

1. **A — baseline**: `bun test test/<file>.test.ts` from a clean tree;
   record pass/fail and the set of test names.
2. **Migrate** — one mechanical transform per idiom, kits first: replace the
   hand-rolled scratch HOME/repo/spawn idioms with the kit that already
   shapes them (mapping below). Keep every `test()`/`describe()` name
   verbatim — the claim-check done-gate diffs test names against the claim
   baseline and flags renames.
3. **B — verify**: same file, same single-file runner invocation, run
   immediately after the edit. **Exit contract: identical pass/fail set as
   A.** Any name change, skip change, or new flake = restore the file
   byte-exact (`git show <baseline-sha>:<path>`) and re-derive — not a
   fix-forward chase.
4. **qlty** `fmt --no-upgrade-check` + `check --no-upgrade-check` on the
   changed file, then next file. Commit per density-decile (not per file —
   491 files at one commit each is 491 commits). Per-decile commits keep the
   per-file A/B evidence in the lane transcript, which is what the W833
   done-gate scans: a green single-file run must exist in the transcript
   per file, and no test-affecting line may change after it.

## Kit map — what replaces what

| Hand-rolled idiom | Kit replacement |
| ----------------- | --------------- |
| mkdtemp scratch HOME + git-inited repo + spawnSync CLI door (`bun hooks/bin/<cli>.ts …`) | `cliFixture(label)` (`test/helpers/cli-e2e-harness.ts`) — temp HOME with fresh governor.db, real git repo + sentinel, `run/seed/q/ins/registryFromHelp` seams |
| dispatch-suite scratch HOME/repo + no-op executor + dead-front env pins + tool/dispatch spawn helpers | `dispatchHarness(afterAll, {tag})` + `stubBuckle()` (`test/helpers/dispatch-harness.ts`) — knobs pinned AFTER `...process.env` (W670) so operator env cannot leak into spawns |
| `Bun.serve({port:0})` board/admin stubs | `boardFixture()` + `unusedPort()` (`test/helpers/board-fixture.ts`); dispatch-shaped buckle stubs → `stubBuckle()` |
| hubctl deploy-route fixtures (env-dir + fake ssh/docker bins) | `hubctlRouteFixture(dir)` (`test/support/hubctl-route-fixture.ts`) |
| Playwright e2e board/console bootstraps | `e2e/harness.ts` (dedupe against `board-fixture` is B1's first unit) |

Kit-addition rule: kits are shared by four lanes in parallel. Additions must
be **additive-only** (new exports; never change an existing signature), one
kit file per commit, and announced with `coord emit BROADCAST` so the other
three lanes rebase cleanly. Kit gaps that need a signature change go through
`coord consult` first.

## Known hazards (fleet lessons applied)

- **Operator-env leak** (W670): fixture knobs (executor pin, dead front,
  attempt caps) pinned AFTER `...process.env` in the spawn env. A migration
  must not reorder that.
- **Git fixtures live in the OS tmpdir**: `mkdtemp` under a checkout walks
  up to the worktree's own `.git` and collides project identity; every
  migrated fixture keeps the `mkdtempSync(tmpdir(), …)` base.
- **Spawn-heavy suites need the file-level timeout**: `setDefaultTimeout`
  at file scope for suites that spawn dozens of CLIs (bun:test default is
  5s per test).
- **mock.test assert-before-restore**: `mockRestore()` resets call counts —
  assert before restoring in migrated files.
- **`/Volumes/Sensitive` mount**: prefer Edit/`sd` over scripted whole-file
  writes; verified per-file single-file runs (A/B) are the drift detector.
- **Fresh worktrees**: `bun install` after take (root node_modules symlinks
  the main checkout), and never `git add -A` afterwards (a run can replace
  the symlink with a real untracked dir).

## Regeneration

The TSV is derived data. To re-run after main moves: the generator is the
classification rules in section "Assignment rules" (import-area votes →
curated overrides → filename tokens, first match wins), one row per
`test/*.test.ts` file with mkdtemp/spawnSync/Bun.serve counts, sorted by
batch, density desc. Keep the TSV committed so batch lanes can trust it
without re-deriving.

