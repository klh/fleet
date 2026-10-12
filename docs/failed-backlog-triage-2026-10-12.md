# FAILED backlog triage — 2026-10-12 (W695)

Lane autow695-p98b319584008df14, branch `suspenders/W695`. Method: each
FAILED item checked against `main` (rg for the symbols, `git log --grep`,
`git merge-tree` for parked refs). Evidence is per row; "verify-first" means
I found no proof either way and did not close it.

## 1. Re-minted as READY (children of W695)

| New | Replaces (now SUPERSEDED) | Why real |
| --- | --- | --- |
| W695.1 | W668, W673 | No seed-stderr/exit-verdict propagation in dispatch-next |
| W695.2 | W674, W679 (W179.2 stays CLAIMED, parked) | No notify.yaml/adapters on main |
| W695.3 | W669.7, .8, .9, W677 | Five `*-html.ts` still in hooks/bin; split ONE emitter per lane |
| W695.4 | W418, W676, W681 | W418.4 inbox-push absent from main; adversarial-first |
| W695.5 | W532, W675, W680 | Controls landed (W532.1, W536); the controlled run never happened |
| W695.6 | W684, W226.1 | Seat never activated; shim path moot |
| W695.7 | W687 | Fix lives on parked/W687; main has no `itemCapsuleKey` |
| W695.8 | W666 | Owner ruling GO+C unexecuted; `refs/archive` is empty |
| W695.9 | W285, W285.1, W286, W290 | enqueue guard, AbandonProcessGroup, `_force_dead_port` gate open |
| W695.10 | W669.12.1 | DRY duplicate; verify first |

Also superseded (landed elsewhere): W688.1.1.1, W688.1.1.2, W688.2 -> W688.1.1.3
(DONE); W233.5 -> W688.5; W669.10 -> W669.12 (DONE).

## 2. Stale — landed on main (closed with note)

W673.1, W678 (lane-completion.ts program + STALL), W664/W665.1 (docs/layout-convention.md
0910c837), W256 (gaps e83a8052), W383 (371cc54d), W408 (2968e85f), W459 (children
merged), W458.6 (2d928059), W536 (0142cb13), W581 (f86a65c3), W576 (children
merged), W688.1 (redo W688.1.1 DONE), W688.7 (W690 records f937527d), W683
(docs/enterprise-gap-review-w688-2026-10-12.md). W311, W412: empty-mission
items, no scope.

## 3. Left FAILED — owner/operator-gated, not stale

W46 (Fireworks key), W484.1 (DSM upgrade GO), W491 (relay tokens), W632 / W493.3 / W688.5 /
W688.6 (NAS route #30282, flip GO), W242 (MTP weights download, capsule has the
exact command), W688.3/.4 (enterprise wiring; W688.7.1 CLAIMED covers part).

## 4. Verify-first (no evidence either way — a lane should check before building)

W214 splines (no code on main), W228, W266.3/W276/W276.1/W382 (supervisor plane;
parked/W266 never landed), W279/W279.1, W280, W282, W284/W284.1, W288, W289,
W359/W393 (identity.db split — parked/W393 absent from main),
W365-W374 (federation/hub wave, no code found), W379/W380 (parked/W253, W254 absent), W530.3
(`lastGood` exists in routes-fleet-tree.ts — may be fixed), W542.1, W552, W552.6, W584
(`worktree sweep` may cover it), W501 (buckle-spoke already in services.yaml),
W378, W376 (80067205 may cover), W381, W230, W682 (W685 may cover), W454, W499, W499's
review doc absent, W530.3, W532-class bench rows, W669.12.2/.3.

None of these were mass-minted; each needs a one-lane check before it is
re-minted or closed.

## 5. Parked branches

49 local `parked/*` refs (brief said ~6 + enterprise; the set grew). `git
merge-tree` vs main:

- NOOP (fully landed, archive-safe): W224, W226, W233.2, W493.2, W624, W624.1, W643, W650, W657.
- Content absent from main, CONFLICT on merge (recover by per-file port): W165
  (profile.ts, secrets-home.ts), W239 (preload-router.ts), W248 (SUPERSEDED, redone as W655 ed86e37c — archive), W393
  (identity-db.ts), W394 (work-cas test), W396 (onboarding), W397 (federation-hub),
  W398 (board trust gate), W400 (console-oidc), W401 (machines registry), W406
  (backpressure), W417.3 (subscribe-registry — partly landed as subscribe-attach), W418
  (inbox-push), W421 (cli.ts verb-kit predecessor), W422.6.1, W424 (13 eval files), W425, W452
  (lane-load-bench), W459.2, W461.2 (SUPERSEDED, landed 7b63f942), W464 (install-doctor), W495,
  W503 (posture), W510 (pre-compact), W512 (lane-model-pin), W516 (turn-boundary), W609
  (claim-fence — W622 touches), W613 (claim-liveness), W616 (failure-class; W616.1 landed),
  W687.
- Zero added files but conflicting (edits to existing files; likely superseded by
  later churn): W349, W361, W377, W389, W422.15, W422.21, W422.9, W441, W459.1 (merged 6ae46492), W530.1,
  W580, W604 (merged d707395a), W626 (merged 7a411956).

Archive-safe set and the re-integration list feed W695.8. W233.2/W239/W248
worktrees are present and idle; check `git status` before `worktree remove`.
