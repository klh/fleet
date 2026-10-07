# parked/\* group audit — 2026-10-07

Audit for W385 (owner-gated retirement). Lane autow385-p98b319584008df14,
branch suspenders/W385. This is the decision record: the owner picks an
option, execution follows the GO.

## Premise vs reality

The item title says "~85 parked snapshot branches (W81–W264 era, freshest
parked/W264)". Measured today:

- **11 parked branches exist**, not ~85 — W165–W516 era, not W81–W264.
- No `parked/W264` ref exists; the freshest parked snapshot is `parked/W516`.
- Renames landed 2026-10-06..07 (`suspenders/W165 → parked/W165` in the
  reflog — a cleanup sweep renamed DONE items' result branches).
- The coordination-protocol.md duplicate the title mentions IS on main:
  `packages/speedy/docs/coordination-protocol.md` (verified). **No docs
  salvage needed.**

## Inventory

All tips are unreachable from main (only `parked/W224` is fully merged).
Every branch is the result branch of a DONE work-graph item; `result_sha`
on the graph equals the parked tip except W226 (its final evidence
`24efaf9` lives on `suspenders/W226`, which is actively checked out and
out of this group's scope).

| Branch | Item | Graph | vs main | Content verdict |
| --- | --- | --- | --- | --- |
| parked/W165 | W165 DONE | sha==result | +1 −240 | profile.ts, secrets-home.ts + federation capability split (+581/14f) **absent from main** |
| parked/W224 | W224 DONE | merged | merged | fully on main — retire-safe |
| parked/W226 | W226 DONE | sha≠result | +1 −237 | intermediate snapshot; final evidence 24efaf9 on suspenders/W226; ikea-shim **absent from main** |
| parked/W349 | W349 DONE | sha==result | +1 −44 | dispatch worktree-branch verify (+257/4f) **absent from main** |
| parked/W361 | W361 DONE | sha==result | +1 −24 | /api/services landed via W273 in evolved form — superseded |
| parked/W424 | W424 DONE | sha==result | +1 −258 | full eval harness, 13 files **absent from main** |
| parked/W503 | W503 DONE | sha==result | +1 −93 | plaid/loop posture (posture.ts + fleet-loop flag) **absent from main** |
| parked/W510 | W510 DONE | sha==result | +1 −80 | pre-compact gate + context-pressure **absent from main** |
| parked/W512 | W512 DONE | sha==result | +1 −69 | Task-layer model pinning **absent from main** |
| parked/W516 | W516 DONE | sha==result | +2 −105 | turn-boundary inbox + oracle **absent from main** |

"Absent from main" = neither the files nor their symbols
(posture/lane-model-pin/pre-compact/turn-boundary/eval/ikea-shim/secrets-home)
exist anywhere on main today. These are DONE items whose result branches
were never integrated — the W412-class gap (auto-integration FAILED, see
docs/owner-correction-taxonomy.md C10).

## Worktree constraint

Six parked branches are checked out in (idle) worktrees: W349, W361, W503,
W510, W512, W516 (`.worktrees/<item>`). Git refuses branch deletion while
checked out, so retirement must remove those worktrees first. All six are
clean (lane residue only: `.klh-brief.md`, `node_modules`, one W503 test
home) — no uncommitted salvage.

## Options

- **A — delete all 11 refs + 6 worktrees.** Cleanest namespace; the graph's
  result_sha evidence dangles and content becomes GC-eligible. Loses the
  seven unintegrated item results.
- **B — archive refs** (recommended): move each parked ref to
  `refs/archive/parked/*` (same tips), delete the branches + worktrees.
  Everything stays reachable, branch listings clean, result_sha evidence
  intact, zero content risk. One command per branch, no working-tree churn.
- **C — B, plus selective integration**: work-add re-integration items for
  the seven absent results (W424 eval harness, W503 plaid posture, W510
  pre-compact, W512 model pinning, W516 turn-boundary, W165 profile split,
  W349 dispatch verify), each rebased onto current main. Most value, most
  work; several were "lift" items parked by the 2026-10-06 sweep.

## Retirement procedure (post-GO only)

```sh
cd /Volumes/Sensitive/github/klh/fleet
git worktree remove .worktrees/W349 .worktrees/W361 .worktrees/W503 \
  .worktrees/W510 .worktrees/W512 .worktrees/W516
# option B: archive each ref, then drop the branch
git for-each-ref refs/heads/parked/ --format='%(refname:short)' | while read -r b; do
  git update-ref "refs/archive/$b" "$(git rev-parse "$b")"
  git update-ref -d "$b"
done
# option A: skip the archive line, add `git branch -D "$b"` instead
```

GO record: _(none yet — owner decision pending)_
