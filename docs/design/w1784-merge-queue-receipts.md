# W1784 — merge-queue rebase receipts

Six DONE branches that conflicted with moved main were merged onto origin/main
(476af9ca), conflicts resolved preserving both semantics, committed on the SAME
branch (plain merge commits, no squash), and pushed. Each push ran the pre-push
gate (188 pass / 0 fail).

| branch              | merged head | conflict resolution |
| ------------------- | ----------- | ------------------- |
| suspenders/W1303.5.2 | 32e2ccfa   | merge.ts import hunk: kept `have` + `mergeHoldActive`, dropped main's duplicate `flagIntegratedCode` |
| suspenders/W1308     | e1ca874b   | same import shape + dangling-paths import re-attached |
| suspenders/W1294.3   | 31393c6a   | 3 rename/rename test conflicts: main's new W1353/W1730 tests ported inside the branch e2e wrappers; bun:test `spyOn` swapped for console capture (playwright 19/19) |
| suspenders/W1265.2   | 75cafdd7   | main's W1297 handlers.ts decomposition barrel taken; branch delta re-homed into proxy-ingress.ts + wire-routes.ts alongside branch's models-route.ts (account-policy suites 43/0) |
| suspenders/W1280     | 374c5162   | main's gates/ import paths won; review-scheduler-w1280 add/add both-sides-identical (22/0) |
| suspenders/W1279     | 52f50799   | main's lanes/ paths + priorBlocking; branchForItem binding preserved (17/0) |

Pre-existing fails classified via detached /tmp A/B rigs at each pre-merge sha
(W1303.5.2: identical 4 fails at d159b500; W1308: identical 7 at f7f10d0d0).

The four clean branches (W1475/W1477/W1714/W1730) are out of scope; they ship
via the review queue.

Caveat for future lanes: `git merge-tree --write-tree` probes reported CLEAN
for all six, but the real merges conflicted — probes are not evidence.
