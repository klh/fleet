# W2690 — parked/W2500 merge resolution record (2026-11-04)

Item: W2690 "rebase suspenders/W2500 onto main (merge ladder conflict)".
Lane: autow2690-p98b319584008df14. Merge commit: fc3fe007 on
`suspenders/W2690` (pushed to origin).

## Context

The merge ladder could not land `suspenders/W2500` (preserved as
`parked/W2500`, tip 56a98303): its review-context `git merge-tree` run
reported a content conflict against current main. W2500 is the W2486
lineage (lost-hub sweep + budgeted requeue) merged onto an older main —
the branch's own tip commit is itself a merge that carried a
`maintenance-legacy-drift.test.ts` resolution.

## Resolution

Merged `parked/W2500` (56a98303) into `suspenders/W2690` (b9a5efa4,
current main lineage). Criss-cross topology — `merge-base --all` yields
two bases (9662991c, 390b18d1) — producing one content conflict:
`packages/suspenders/test/maintenance-legacy-drift.test.ts`, the
`hold-drain` HEARTBEAT_BORN annotation.

Both sides agree the row exists; they disagree on the annotation length.
History: base 9662991c carried the short form (`"W2318"`); commit
390b18d1 (the W2486 repair riding W2500) lengthened it to `"W2318 — born
on the heartbeat (drain-mode dispatch hold)"`. That commit is already an
ancestor of current main (the W2486 lineage landed through the ladder),
so main's side is the newer, author-intended form. Resolved `--ours`
(main's long form) — parked/W2500's tip merge had accidentally carried
the pre-repair short form forward.

The merge is pure topology: the resolved tree is byte-identical to main
(`git diff b9a5efa4 fc3fe007 --stat` empty), and the W2486 payload
(lost-hub.ts bin+lib, maintenance.ts row, lost-hub.e2e.ts suite) is
verified present via `ls-tree`. The merge makes the W2500 lineage an
ancestor of this branch so the ladder lands it in place of the original.

## Evidence

- commit hook corpus (lane gate): 100 pass / 0 fail.
- `lost-hub.e2e.ts` (playwright): 17 passed.
- `maintenance-legacy-drift.test.ts`: 4 pass / 0 fail.
