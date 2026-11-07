# W2756 — rebase record: suspenders/W2733 onto main

Merge commit 21791ac1 on `suspenders/W2756` (base = main 8eaa0e96). The
ladder could not land `suspenders/W2733` itself (merge-tree conflict vs
main); this branch carries the merge resolved against current main and
lands in its place.

## Situation

`suspenders/W2733` (tip f7449323, 24 commits ahead of merge-base 1b76f90b)
holds the W2663 full-corpus playwright port lineage (via parked/W2709):
428 files of `*.test.ts` → `*.e2e.ts` ports, the test-framework pin
re-pinned 236 → 235, the lane-guard trailer-spillover skip, and the
gate/guard plumbing for the ported corpus. Main advanced 72 commits past
the same base without taking that lineage, so the merge is a real content
landing (427-file delta vs main), not pure ancestry.

## Conflict resolved (1 file)

| File | Resolution |
| --- | --- |
| `packages/suspenders/test/fixtures/kev-stub-start.ts` | kept HEAD (main's `KEV_STUB_PORT_FILE` channel) |

Both sides had independently fixed the same playwright defect — child
stdout pipes break inside workers. Main's fix: the stub writes its port
to an env-named file (`kev-stub.ts` cooperates; that support rides main
and the merge takes it cleanly since W2733 never touched `kev-stub.ts`).
W2733's fix (W2224 lineage): stdout redirected to a temp-file fd, polled
with ANSI stripping + `NO_COLOR`. Kept main's channel — it has no stdout
dependency at all, and the merged `kev-stub.ts` (main's) writes the port
file it needs. Same exported signature on both sides, so the ported
corpus callers are unaffected. Proven live: the three suites using
`startKevStub` pass under the playwright runner (52 passed).

## Functional content riding the merge (beyond renames)

- `hooks/lib/lane-guard.ts` — trailerVerdict skips tab-less spillover
  lines (`%(trailers:valueonly)` emits value+newline; W2224/W2359 fix).
- `packages/suspenders/package.json` — `test`/`ci` scripts now
  `playwright test --config test/playwright.config.ts`; `test:e2e` loses
  the `bunx --bun` prefix. Dep rows unchanged; bun.lock untouched by the
  merge; `bun install --frozen-lockfile --dry-run` clean.
- `hooks/lib/gates/test-import-resolution.ts` — collector also globs
  `*.e2e.ts`; guard floor 500 → 1000.
- `.githooks/post-commit` — suite list renamed to the `.e2e.ts` suffixes.
- `tests/helpers/fleet.import-ratchet.pin.ts` — 15 rows dropped for
  files whose cross-package reach-ins were swapped to `@klh/*` imports
  (all declared in devDependencies).

## Verification (run on the merged tree, this lane's transcript)

- `bun test tests/test-framework-guard.test.ts` — pin 235 = merged-tree
  count 235 (pass); `tests/test-import-resolution.guard.test.ts` — scan
  floor 1000+ (pass).
- Playwright root guards: `law-guards.e2e.ts` +
  `fleet.import-law.guard.e2e.ts` — 24 passed.
- Suspenders: `work-completion-record` + `consult-kb` +
  `consult-federation` (the kev-stub users) — 52 passed;
  `risk-tier` + `wallclock` (the specs W2733's tip called out) —
  16 passed; `lane-guard.test.ts` + `lane-commit-trailer.test.ts` —
  20 passed / 0 fail.
- Merge-commit pre-commit gate: 100 passed (1.3m).

## Pre-existing reds (disclosed, NOT fixed here — tree identity vs main)

- `tests/test-import-resolution.guard.test.ts`: 2 dead relative imports
  in `packages/local-llm/{lane-load-bench,spawner}.test.ts`
  (`SPECIALISTS` missing-export, `kit` empty-surface). Both files are
  byte-identical on main (zero local-llm files in this branch's delta);
  read-only probe of `checkTestImports` against the main checkout at
  8eaa0e96 returns the identical two violations. Repair belongs on main.
- `tests/knob-registry.guard.e2e.ts`: `SUSPENDERS_RISK_TIERS`
  (`hooks/lib/fleet-loop/merge.ts:364`) has no KNOB_REGISTRY row.
  `merge.ts` and `settings.knob-registry.ts` are both byte-identical on
  main — same verdict there. The registry row lands with main's fix.
