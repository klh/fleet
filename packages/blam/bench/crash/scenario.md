# CRASH S1-S5 control-plane scenarios — spec (W840)

Deterministic, LLM-optional reproduction scenarios for the five CRASH
control-plane failure classes the bench README specifies. Each scenario
seeds a known failure condition with scripted stand-ins (table rows, no
model calls), runs the control plane under test, and scores the docs/metrics.md
axes: property satisfaction, TTD, TTR, false-block rate, data loss. A
scenario must reproduce ≥9/10 runs — this suite is fully deterministic
(no RNG, no wall clock; logical ticks), so repeated runs are byte-identical
(10/10, asserted by the harness contract and the bun test).

Run: `bun packages/blam/bench/crash/harness.ts`

## World model

A real git fixture repo per run (deterministic: pinned author/committer
dates, severed global/system git config), stand-in table for liveness
(kill() flips the row; no OS processes), a scripted registry with a lag
window (REGISTRY_LAG_TICKS = 2 sweeps), `.fleet/merge-active` marker in
the real layout, and a logical sweep clock (1 tick = 1 sweepCycle).

## Eras (the A/B)

The control plane under test is the v0 scripted reference plane
(plane.ts) with two eras; suspenders itself adapts via the README's four
functions and becomes the next cell, not the first one:

- **pre** — 2026-09-28 incident behavior: the sweep acts on the registry
  alone (no act-time revalidation), kill(pid,0) liveness (a recycled pid
  is "alive" forever), abort-only recovery that cannot clear staged
  debris (the R1 stall), escalation force-prunes (data loss), bare
  commits allowed (a bare commit concludes a foreign merge).
- **post** — the current guard set: act-time ground-truth revalidation
  (branch on disk + stand-in alive before a retire act), pid+argv
  identity liveness (mirrors the W101 marker contract), heal-first
  recovery preserving staged debris to `refs/blam/debris/<branch>`,
  force-prune never (no data loss), foreign-commit gate (no commit while
  a foreign merge marker is live).

## Scenarios

### S1 — C1 registry-lag (`scenarios.ts s1`)

- Fixture: branch `work/W-900` + live stand-in dispatched; registry entry
  lags 2 ticks.
- Injection: the sweep runs inside the lag window.
- Window: 3 sweeps.
- Properties: `no-false-retire` — no retire act on a mid-spawn lane.
- Measured: pre 0/1 (false retire at tick 1, FBR 1); post 1/1 (skip-alive
  guard, TTD 1).

### S2 — C2 liveness-forgery (`scenarios.ts s2`)

- Fixture: crashed runner debris (MERGE_HEAD + staged content), marker
  pid 424242; the recycled pid is LIVE under an unrelated command
  (`bun run code-server`, argv mismatch).
- Injection: sweep sees forged-alive marker.
- Properties: `debris-healed` — heal runs inside the window.
- Measured: pre 0/1 (heal-deferred every tick, TTD —); post 1/1 (heal at
  tick 1 — identity liveness sees through the forgery).

### S3 — C3 check-then-act (`scenarios.ts s3`)

- Fixture: dead lane on `work/W-901` (retire otherwise legitimate).
- Injection: `midSweepHook` fires the park-rename
  (`work/W-901` → `work/W-901-parked`) between the sweep's check and its
  act; the registry entry is dropped by the park.
- Properties: `no-retire-on-vanished` — the retire act never fires on a
  branch name that no longer exists.
- Measured: pre 0/1 (retire on the vanished name, tick 1); post 1/1
  (skip-vanished guard, TTD 1).

### S4 — R1 debris-blocks-recovery (`scenarios.ts s4`)

- Fixture: crashed ladder run (MERGE_HEAD + staged `debris.txt` from
  `work/W-999`), dead runner stand-in, next branch `work/W-902` queued.
- Properties: `debris-cleared-in-cycle` (heal at tick 1),
  `next-not-falsely-failed` (no blame event for W-902), `no-data-loss`
  (no force-prune).
- Measured: pre 0/3 (recovery failed, W-902 blamed at tick 1, force-prune
  at tick 2 → data loss 1); post 3/3 (heal tick 1 preserving debris to
  `refs/blam/debris/work-W-999`, W-902 merged tick 2, TTR 2).

### S5 — S1 foreign-merge-conclusion (`scenarios.ts s5`)

- Fixture: live runner mid-merge (marker pid 6001 alive) + MERGE_HEAD;
  lane B stages its own file and commits.
- Control leg: the runner concludes its own merge, then lane B retries —
  both must pass on both eras (gate precision).
- Properties: `no-foreign-conclusion`, `control-commit-passes`.
- Measured: pre 1/2 (the bare commit concluded the foreign merge — a
  two-parent commit by the wrong actor); post 2/2 (refused at tick 1;
  owner conclusion + retry land).

## Measurement window and tick semantics

Sweeps are logical ticks (WINDOW_TICKS = 3 per scenario). TTD = first
correct plane signal (guard skip, heal, refusal) in ticks from the first
post-injection sweep; TTR = ticks to restored correct state (heal +
queued merge landed); null ("—") = never inside the window. False-block
= a legitimate scripted action denied (S1's retired lane, S4's blamed
branch, an over-blocking refusal in S5's control leg). Data loss =
commits that existed and became unreachable (S4's force-pruned branch).