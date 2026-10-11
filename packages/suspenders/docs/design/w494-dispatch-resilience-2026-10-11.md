# W494 — dispatch resilience: honest lane liveness + dead-lane auto-resume

Parent closure record, 2026-10-11, lane autow494. Branch `suspenders/W494`.

## Incident

2026-10-06: corp VPN darkened z.ai; lanes died mid-claim but kept counting as
live. `work lanes` judged liveness by REGISTERED WORKTREE existence — 14
worktrees of DONE items (merge/retire skipped by the morning crash) filled the
dispatch target with 8 ghost lanes; fleet-loop dispatched nothing for hours.

## Root fixes (each landed by a child item)

- **A — honest liveness (W494.1)**: liveness = daemonized-PID process probe
  (heartbeat lease as fallback); registered-worktree existence demoted to
  sweep evidence. `hooks/lib/lane-liveness.ts`, `hooks/lib/reclaim-liveness.ts`.
  Coord gc staleness predicate aligned to the same probe.
- **B — dead-lane requeue + supported sweep (W494.2)**: fleet-loop detects a
  claim whose pid is gone → `work reclaim` of that sid; the worktree is left
  for the sweep, guarded by patch-id cherry (not ancestry — the amend-era
  rewrite makes ancestry lie). Supported verb: `worktree sweep` (W494.2.2) in
  `hooks/bin/worktree.ts` — guard-first, recovery ref pinned.
- **C — the supervisor's supervisor (W494.3)**: `scripts/dispatch-watchdog.ts`
  self-heals a dead fleet-loop, survives a down front (probe verdicts, never
  crashes), and the lane subscribe self-terminates on session death.

## Verify

```
bun test packages/suspenders/test/lane-liveness.test.ts \
  packages/suspenders/test/reclaim-liveness.test.ts \
  packages/suspenders/test/watchdog-liveness.test.ts \
  packages/suspenders/test/watchdog-verdict.test.ts \
  packages/suspenders/test/worktree.test.ts \
  packages/suspenders/test/fleet-loop-dispatch.test.ts \
  packages/suspenders/test/fleet-loop-ship.test.ts \
  packages/suspenders/test/lane-process-identity.test.ts
# 56 pass, 0 fail
```

## Notes

- The children's commits reached main before this record (W494.3's
  `3517ec2` rides main's history); this record closes the parent.
- Follow-ons already landed on top: W494.2.1 registry-claim recovery,
  W494.2.2 sweep verb hardening, W626 native-install liveness (adapters
  declare `installPaths` for launchd's bare PATH).
