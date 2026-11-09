# W2912 — re-rebase of suspenders/W2855 onto the current main lineage

Parked/W2855 (35 commits, 1363 files) carries the chord + pi-durable
vendoring, the p1 pin re-stamp, and the runner-safe-errors work. The merge
ladder refused the original branch; this re-rebase lands it on origin/main
64348ea6 in a /private/tmp worktree (mount-sync-immune tree).

## Merges

- **Merge 1 — parked/W2855: CLEAN.** No conflicts; bun.lock auto-merged.
- **Merge 2 — suspenders/W2902 (fork-exemption stack): CLEAN.** No
  conflicts; bun.lock auto-merged (67,319 bytes at the landing).

## Accommodations

- **Test-framework ratchet:** the lineage's new legacy suite
  `packages/suspenders/test/report-tab.test.ts` (W2550.3 report URL
  contracts) pushed the count over the 570 pin. Ported to the tagged
  convention: `git mv` to `report-tab@unit.e2e.ts`, import swap to
  `@playwright/test`, describe unwrapped (the bun loader resolves
  @playwright/test with no `describe` named export). 3/3 green under the
  suspenders config; count back at the pin.
- **W902 wall-clock law:** this lineage predates the W2909/W2911 fix — the
  fleet-authored `pi-extensions/fleet-awareness/panel.ts` still rendered a
  bare `toLocaleTimeString()`. Same dualShort fix applied; law guards green
  after.

## Proofs

- root: law-guards + import-law + knob-registry 25 green; test-framework +
  import-resolution bun guards 9 green (count at pin); report-tab ported
  suite 3 green.
- qlty on-save gates passed on the touched files; scrub clean.
- Record at docs/design/w2912-w2855-re-rebase.md; pushed as suspenders/W2912.
