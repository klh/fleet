# W842 — developer onboarding + laptop capacity (one-repo pilot)

Supported clean-machine onboarding path for fleet contributors, plus a
measured answer to "how many local worktree lanes does this laptop hold".

Status: landed on `suspenders/W842` (see `work show W842` for the head sha).

## Onboarding path (clean machine → productive lane)

1. **Bun + agent CLI**: install Bun ≥ 1.x and one agent CLI
   (`claude` / `codex` / `copilot`).
2. **Installer**: `bash install.sh [--wire]` from
   `packages/suspenders` — the ONLY repo→prefix sync; installs shims
   (`work`/`coord`/`dispatch`/`doctor`) and registers hooks.
3. **Machine conf** (the sole conf; repos carry placeholders):
   `~/.config/klh/stack.yaml`, `~/.claude/local-llm/belt.env` (upstream
   keys + `BUCKLE_ADMIN_KEY`), `~/.claude/local-llm/buckle-spoke.env`
   (gate root key). Mode 600.
4. **Scoped keys**: per-lane `bksk_` keys are minted per dispatch; the
   doctor proves the chain with a mint→verify→revoke roundtrip.
5. **Doctor**: `bun ~/.claude/hooks/suspenders/hooks/bin/doctor.ts check
   --repo <path>` — static verification of bun, agent CLI, gateway
   credentials, machine conf, repository rules (AGENTS.md, .qlty,
   core.hooksPath=.githooks), project identity (work graph). Exit 0 pass /
   1 warn / 2 fail. `... smoke` exercises the live control plane: board
   read face + gate scoped-key roundtrip. Run both from the INSTALLED
   prefix (`/.harness/` origin is reported in the output).

## Capacity results (run4 @ e6dd0660, 2026-10-19)

One service repo (buckle), task = full buckle test suite, per-lane flow =
`bun install` + task, N detached worktrees under `.fleet/capacity-bench/`,
1s system sampling (top/vm_stat door: `parseTop`/`parseDf` in
`scripts/lib/capacity-math.ts`). Machine: M5 Max laptop, warm bun cache.

| lanes | wall   | install p95 | task p95 | peak CPU | peak mem | disk min |
| ----- | ------ | ----------- | -------- | -------- | -------- | -------- |
| 1     | 21.3s  | 0.3s        | 19.6s    | 25.1%    | 88G      | 2630GiB  |
| 2     | 23.5s  | 1.8s        | 19.8s    | 35.3%    | 88G      | 2630GiB  |
| 4     | 29.7s  | 6.3s        | 19.9s    | 51.3%    | 88G      | 2630GiB  |

**Reading**: task wall inflates only ~1.5% from 1→4 lanes (19.6→19.9s
p95); peak CPU 51% of the machine; memory flat (~+0.7G/lane). Install
contention is the visible cost (0.3s→6.3s, 21× but small in absolute
terms). Verdict: **4 worktree lanes fit comfortably on this laptop**;
CPU is the first wall, not RAM or disk.

**Found while measuring** (landed same branch): buckle test fixtures keyed
`/tmp` db paths by `Date.now()` alone — same-millisecond lane starts
collided (`SQLiteError: database is locked`), failing concurrent runs
deterministically. Fixed by pid-suffixing all 33 fixture paths (18 files);
the 4-lane matrix runs green since `e6dd0660`.

## Boundary with W539.1

W539.1 (two-developer/two-hub IKEA health-policy pilot) owns
multi-hub federation, policy transport and CLI adapters. W842 is
single-machine onboarding + capacity only — no federation scope here;
the doctor's checks stop at the local control plane.

## Files

- `packages/suspenders/hooks/lib/doctor.ts` + `hooks/bin/doctor.ts` —
  check/smoke verbs (verb-kit)
- `packages/suspenders/scripts/capacity-bench.ts` +
  `scripts/lib/capacity-math.ts` — bench harness + pure helpers
- `packages/buckle/test/*` — pid-suffixed fixture paths (33 sites)
- raw records: `.fleet/capacity-bench/w842-run4.ndjson` (untracked)