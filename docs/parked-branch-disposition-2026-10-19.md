# parked/\* conflict-class disposition — 2026-10-19 (W782.2)

Part 2 of the W695.8 ruling execution: the 20 conflict-content-absent refs the
2026-10-12 triage (§5) held for verdict. Evidence per row: file presence +
symbol greps against `main@11005782` (2026-10-19). Verdicts: ARCHIVE = ref
moved to `refs/archive/parked/*` (recoverable, commits stay reachable) + idle
worktree dropped; RE-INTEGRATE = re-integration child minted.

| Branch | Verdict | Evidence |
| --- | --- | --- |
| W239 | ARCHIVE | preload-router/brief-compose absent, 0 symbol hits; value contingent on the open knowledge-metering decision (event #4585) — re-mint if GO |
| W393 | ARCHIVE (landed) | `hooks/lib/identity-db.ts` + `test/identity-split.test.ts` ON main; route closed via W323 |
| W394 | ARCHIVE (landed) | CAS/fencing in main `work.ts` (work-fence/expectedRev/claim_epoch, W609 content); `work-mirror.ts` on main |
| W396 | ARCHIVE | onboarding wizard absent (only W842 doctor mentions onboarding); product-surface contingent |
| W397 | ARCHIVE | federation-hub/federation-up absent; main federation.ts is phase-1; hub-push should be re-designed against current hubctl, not a Sept port |
| W398 | ARCHIVE (superseded) | main trust design = host-guard + `x-klh-write-token` (13 files, W264), not the branch's shared-secret `board/gate.ts` |
| W400 | ARCHIVE (superseded) | oidc surface landed via ent-seam/auth/identity-federation/stack-config; branch's console-oidc/console-session design not adopted |
| W401 | ARCHIVE | machines registry absent; multi-machine inventory now hubs.json + resolveHub + hubctl profiles |
| W406 | ARCHIVE | governor.ts/effectiveTarget absent; branch targets the pre-v16 dispatch plane (superseded by W276 re-land) |
| W417.3 | ARCHIVE (landed) | subscribe reap live as `subscribe-attach.ts` reapIfIdle + session-end (confirmed by W695.4 done record) |
| W418 | ARCHIVE | successor W695.4 DONE evaluated W418.4 and did not land it (inbox-push 0 hits on main) |
| W421 | ARCHIVE (superseded) | `lib/verb-kit.ts` (W276) owns parsing/help; parseArgs gone from work.ts/coord.ts |
| W422.6.1 | ARCHIVE (landed) | seedLocalLlm in install-contract/install-llm-steps/install-run (W771.2, 2026-10-18) |
| W425 | ARCHIVE | belt example configs + config-placeholders.test.ts absent; re-mint under an install-grade config-drift wave if wanted |
| W452 | RE-INTEGRATE | metrics-alert half landed (`hooks/bin/metrics-alert.ts`); lane-load bench (2 files) absent — child **W782.2.1** minted |
| W459.2 | ARCHIVE (landed) | exec-namespace/lane.$\{sid\} concepts across board data/exec/lanes + stage2 inventory doc |
| W464 | ARCHIVE (superseded) | W842 doctor (`hooks/bin/doctor.ts` check+smoke) + W771.2 install tail cover post-install verification |
| W495 | ARCHIVE | stale test-churn port (32 files vs a week of churn); env-knob pinning landed via W670-class work |
| W609 | ARCHIVE (landed) | `lib/work-fence.ts` on main + 6 referencing files; unlanded remainder (work-schema extraction) moot |
| W613 | ARCHIVE (landed) | claim-liveness symbols in work.ts/coord/fleet.ts/reclaim-all.ts; reclaim-all ran live 2026-10-19 |

## Execution record

- 20 refs archived at survey shas (ea375c02, 4eee783c, 94611783, 4dce631b,
  984351ca, 243b8d82, 34e78028, e03a4d82, 88623503, 74bdbdfd, 96b26d36,
  787ea44c, 54fed834, fad6ca8e, 6e74115e, 91105310, bcd47b8e, fc52da02,
  152382d2, 2df48987); branches dropped; `worktree prune` clean.
- 19 worktrees removed `--force` (W418 had none). Per-tree dirt was lane
  residue (briefs, node_modules, bun.lock, .klh-done.md) except W452's one
  tracked test-fixture tweak (`metrics-alert.test.ts` oldestMs 3h→30h) —
  stale against the landed metrics-alert, lost uncommitted by decision.
- Pre-flight: no processes referenced any of the 20 trees (no W643-class
  hold), `work lanes` showed no live claim on them, rogue-reap active.
- Re-integration: W782.2.1 (READY) for the W452 bench. Remaining parked heads
  (W165/W349/W424/W503/W510/W512/W516/W643-held, W7xx-W9xx result branches)
  are outside this item's list and untouched.
