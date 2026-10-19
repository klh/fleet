# W782 — skipped / postponed / forgotten sweep

2026-10-19, lane autow782-p98b319584008df14, branch `suspenders/W782`.
Read-only review: `doesnt_work.md`, `.klh-done.md`, coord facts
(`lesson.*` 118, `finding.*` ~70), the NEED_DECISION backlog (10 901
events), and the condition-gated items. Method: every candidate checked
against the live work graph (`work show`) and the current tree.

## Landed — closed, verified this session

| What | Evidence |
| --- | --- |
| W695.6.1 retry-after cap | DONE, `3d1a3596` |
| W695.3.7 parked-ladder merge | DONE, `8e6163c8` |
| W695.8.1–.7 parked re-integration (W424/W503/W510/W512/W516/W165/W349) | all DONE |
| W658.3 gitleaks blocker | fingerprint present, `.gitleaksignore:62` |
| W242 MTP re-bench | active, not forgotten — #44181/#31342 superseded by #44429 (RavenX complete, bench dispatched, AC-gated cron armed) |
| W866 / W688.3 / W484.1 / W695.5/.7/.9/.10 | DONE on the graph |

## Still open — postponed, each needs a trigger or an owner

1. **Copilot-quota triplet, no re-fire mechanism.** W738 (opus re-review),
   W695.6.2 (tool_use proof), W731 (copilot opinions digest) are all FAILED
   on the 2026-11-01 seat-quota wall — and FAILED has no reclaim path
   (retry/NEED_DECISION only). Nothing and no one holds the
   `work retry` trigger for ~2026-11-01.
2. **Parked-branch residue, part 2.** `docs/failed-backlog-triage-2026-10-12.md`
   §5 listed ~20 conflict-class parked refs; W695.8's 7 children covered only
   the subset its description named. W239, W393, W394, W396, W397, W398,
   W400, W401, W406, W417.3, W418, W421, W422.6.1, W425, W452, W459.2,
   W464, W495, W609, W613 were never re-minted nor archived — idle
   worktrees still live in `.worktrees/` (W239/W359/W377/W389/W393/W394/
   W396/W397/W398…). This is the genuinely forgotten set.
3. **NEED_DECISION #38753** (pinned-cloud gate) — open 7d, blocks the
   pinned leg of W695.6.2; asker recommended option (1) "pin =
   authorization". Unrulled.
4. **W552** — machine work done and verified; sole remaining step is the
   owner-gated Screen Studio capture (BLOCKED record #46056). Keep parked.
5. **W46 / W491** — owner-gated FAILED (Fireworks key / observation-relays
   config). Known, correct to stay closed-pending-owner.
6. **W179.2** (notification fan-out) — CLAIMED by a dead session since
   before 2026-10-12, deliberately "parked" in the triage; the feature
   (email/Slack push for NEED_DECISION/lane-death) has never landed. Needs
   a disposition: retry, or owner-close.
7. **skills/local/SKILL.md:14 port-role drift** — W772.1's carried WARN;
   the :8901/8902 role labels still disagree with the belt registry.
   One-line doc fix, never follow-up'd.
8. **Stale `.agents/skills/fleet/` copy** — W772.1 hygiene note; untracked,
   not gitignored, still on disk.

## Noise finding

Budget-exhaustion NEED_DECISIONs re-fire for the same item 4–6× per cycle
(W866, W688.3, W530.3, W499… — several of which are already DONE), burying
real owner decisions like #38753 in the feed. A dedup/throttle on
per-item budget events is a tooling follow-up.

## Follow-ups minted

W782.1 quota-triplet re-fire · W782.2 parked-branch residue part 2 ·
W782.3 port-role drift fix · W782.4 NEED_DECISION throttle ·
W782.5 W179.2 disposition — all READY children of W782.

## Obsolete (records, correct as-is)

`docs/failed-backlog-triage-2026-10-12.md` §1/§2 superseded by the W695.8/.9
landings; `doesnt_work.md` W240 KV-flags and W242 rows still hold their
revisit conditions (not yet met); the W695.6 Copilot row is current.

VERDICT: CLEAR - 3 forgotten sets found (quota-triplet re-fire, parked-branch residue part 2, W179.2 disposition) + 2 hygiene follow-ups; everything else verified landed or correctly owner-gated.
