# W382 — parked/W266 supervisor-plane integration verify (2026-10-16)

Mission: integrate parked/W266 WITH CARE once children W266.2/.3 settle —
`hooks/coord/supervisor.ts` + `lib/supervisor.ts` + test were reported landed
nowhere despite W266.1 DONE.

**Verdict: the plane already landed on main via W276 (`275ce852`, 2026-10-15)
— no re-apply needed.**

Evidence:

- Settle precondition met: W266.2 DONE (`bb7a84ea`), W266.3 DONE
  (`5431b6f2`).
- `275ce852` is an ancestor of this branch; its payload against the parked
  tip (`d5e47411`):
  - `hooks/coord/supervisor.ts` — byte-identical to parked
    (`git diff HEAD:<path> parked:<path>` empty).
  - `hooks/lib/supervisor.ts` — parked content plus the structural
    `SupervisorDb` port (raw `bun:sqlite Database` → query/get/all/run port,
    govdb-store pattern); a strict improvement, nothing dropped.
  - `test/supervisor.test.ts` — parked content plus the ladder-top
    adaptation (parked froze `user_version = 11`; landed asserts
    `>= 11` against the current v16 rung). **24/24 green** in this worktree
    (50 expect calls).
- Wiring present: `supervisor ensure|status` verb registered in
  `hooks/bin/coord.ts` (verb-kit row + `cmdSupervisor` import); the
  session-start supervision-fact hunk sits beside the W637 arming block.
- Parked extras audited and absorbed:
  - Schema-pin commits (`10 → 11`) — superseded: the supervisors table is
    the ladder's v16 rung on the current govdb-open ladder.
  - `.gitleaksignore` entries — pre-monorepo fingerprints (old-repo shas,
    `test/*` paths); superseded by the owner-approved suppressions from the
    fleet cutover.
  - `scripts/supervise.ts` + `test/supervise.test.ts` — W146 lineage,
    already in-tree from the mainline, not part of the W266.1 payload.
- With-care regression check: `test/supervise.test.ts` shows 3 deterministic
  fails (the W576.1 launch-authority trio). Detached A/B at `275ce852^`
  (`d4f8cadc`, pre-re-land) reproduces the **identical fail name-set** —
  pre-existing on the mainline, not caused by this integration. Flagged for
  the owner, out of W382 scope.

Conclusion: parked/W266 is fully superseded by `275ce852`; the integration
is verified complete. Remaining watch item: the W576.1 supervise-suite trio.
