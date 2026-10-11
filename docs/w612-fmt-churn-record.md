# W612 fmt churn — resolution record (2026-10-11)

## What happened

Lane autow612 ran `qlty fmt --all` in `.worktrees/W612`: 150 files of pure
biome-canonical churn, left uncommitted because the two-person rule blocked a
lane-initiated `git restore`. The stop gate (`gates/stop.ts`) lints
git-status dirty files, so pre-existing lint debt in churned files
(subagent-statusline.ts, swarm-watch.ts forEach returns, lit-dev template
scaffold members, brainstorming helper.js/server.cjs) blocked session end.

## Resolution — owner option (b): labeled reformat commit

Three commits landed on `suspenders/W612` (2026-10-11, 00:56–01:15 +03):
all merged to `main`; `git log main..suspenders/W612` is empty.

- `c324ac7` — stop-gate lint fixes: belt/blam/local/speedy (8 files)
- `970f98a` — stop-gate lint fixes: speedy hooks + skill scripts
- `f5a7288` — "W612 tree hygiene: biome-canonical reformat, 150
  stale-format files" (150 files, +31464/−43681)

The unscoped-`--all` restore path (owner option (a), approve-destructive
co-sign) was never needed. Files with intentional changes (blam
`bench/paired`, `test/paired.test.ts`, `bench/README.md`) were committed
alongside the churn, so nothing was lost. `.worktrees/W612` is clean
(only untracked `.klh-brief.md` + `node_modules`).

## Doctrine reaffirmed

`qlty fmt` stays scoped to changed paths (`qlty fmt --all` reformats
untouched files on biome drift — see W612 fallout, this record). Batch
reformats are deliberate labeled commits, never drive-by side effects.
