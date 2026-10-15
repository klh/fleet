# W774 — the `.fleet` state-store audit verdict: governor.db is the store

W769's audit (finding #4) flagged `.fleet/wisdom`, `.fleet/consults`,
`.fleet/capsules` as unwired state stores holding zero rows, with a
wire-or-remove verdict needed per store. This record is that verdict,
evidence-first. **Verdict: all three writers are live; persistence moved to
governor.db; the `.fleet/*` paths were never stores — nothing to wire,
nothing to remove.**

## The refutation

The flagged dirs do not exist and never did:

- Live disk: `.fleet/` holds lane logs, `lanes.json`, launch registries,
  `loop.log`, `dispatch-watchdog.*`, `demos/` — no `wisdom/`, `consults/`,
  `capsules/` directory.
- History: `git log --all -S '.fleet/wisdom'` (and the consults/capsules
  variants) returns zero commits — no tracked revision ever wrote those
  paths, so no writer exists to be dead.
- Code: zero references to the three paths anywhere in the repo (all file
  types, hidden included). The only hits were this item's own brief.

The premise came from reading sweep telemetry as a file store: fleet-loop's
`WISDOM n flagged` line is a log of the governor.db sweep, not a write to a
`.fleet/wisdom` dir.

## Per-store verdict

| Store | Persistence (governor.db) | Live writer | Live evidence 2026-10-15 |
| --- | --- | --- | --- |
| wisdom | `facts` (`wisdom.<C>.<subject>`) + `events` (NEED_DECISION) | `hooks/coord/wisdom.ts` wisdomSweep — fleet-loop cycle step 5 + `coord wisdom` | 4 `wisdom.*` facts (`coord fact list --prefix wisdom`); `.fleet/loop.log` shows daily flag+emit through 2026-10-15 |
| consults | `consults` + `consult_kb` (+FTS5) | `coord consult` / `consult-reply` (hooks/coord/consult.ts); expiry sweep consult-expiry.ts; board diagnostics read the same tables | `coord kb stats`: 4 human consults, 9 kb solutions |
| capsules | `facts` (`lane.<sid>.capsule`, `work.capsule.<proj-tag>.<item>` — capsule-fence.ts itemCapsuleKey) | `coord capsule set` + closure paths (lane-completion.ts, work-completion-record.ts); capsule-fence.ts bounds + resume-validates the same rows | 139 `lane.*.capsule` facts; `work.capsule.98b319584008df14.W768` present |

## Decision

- Keep all three stores exactly as they are: coordination state lives in
  governor.db, reached via the coord/work CLIs and the board API — the
  sanctioned access paths. `.fleet/` remains operational scratch (logs,
  lane registry, launch receipts), never a state store.
- The W769 audit's wire-or-remove fork does not apply: a store that never
  existed cannot be wired or removed. Re-audits should query the live
  stores (`coord fact list --prefix …`, `coord kb stats`, `coord events`)
  instead of directory-shaped expectations.
