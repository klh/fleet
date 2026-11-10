# W2949 — protect DONE branches from post-close merges and repair stale-SHA closures

## Decision

DONE closures are guarded by **detection, not blocking**: a recurring census
(`hooks/bin/completion-integrity.ts`, 1800s fleet-loop heartbeat) compares
every DONE item's banked `result_sha` against the live branch head at
`refs/heads/suspenders/<id>` and emits `work.completion_drift` +
`NEED_DECISION` per new head — a decision surface, not a gate. DONE records
stay immutable; the branch ref is where drift is allowed to happen but not
silently.

## Background

The Part-A trigger was concrete: W2941/W2942 closed DONE with a banked sha
while their branches carried post-close merge commits — the DONE record
pointed at a sha that the branch no longer contained at its tip, so
`work done` evidence (`--sha`) no longer described the branch's contents.
Part A (one-off re-anchors) landed in the W2941/W2942 closure commits;
Part B (this item) is the generic mechanism.

## Design

`bun hooks/bin/completion-integrity.ts [--act] [--repo <dir>]`

- **Census**: `SELECT id, result_sha FROM work_items WHERE project = ? AND
  state = 'DONE' AND result_sha IS NOT NULL AND result_sha != ''` (BIND
  parameter — the bind-less path was the root-identified bug #120327).
- **Branch heads**: `git for-each-ref refs/heads/suspenders/ --format
  '%(refname:short) %(objectname)'` → map keyed `suspenders/<id>`.
- **Classification**: absent branch → skip (nothing to guard); head ===
  banked → skip (healed or never moved); same head as a prior episode →
  carry silently (dedupe); else new episode, classified via
  `git merge-base --is-ancestor <banked> <head>` →
  `descendant` (base moved ahead — benign base move) or `divergent`
  (history rewritten — a finding).
- **Act path**: one `work.completion_drift` + one `NEED_DECISION` per new
  head ("re-anchor the branch to the banked sha or mint an explicit repair
  item"). Episode state rides `.fleet/completion-integrity.json`, written
  atomically (tmp + `renameSync` after `mkdirSync` on `.fleet/` — a torn
  write would break dedupe and re-fire events every 1800s cycle).
- **Exits**: 1 on a dry-run finding (a human or the loop should notice);
  0 clean or after an acted census.
- **Wiring**: maintenance.ts heartbeat row (`everySeconds: 1800`) +
  `HEARTBEAT_BORN` audit row `"completion-integrity": "W2949"` in
  test/maintenance-legacy-drift.test.ts.

## Boundaries (deliberate non-goals)

- **Write-time rejection** of post-DONE mutation (a push/done-gate that
  refuses a branch move after closure) is W2954's lane — this census never
  resets content and never re-banks a DONE record.
- **Repeated-FAIL breaker** (an item whose review legs FAIL repeatedly and
  burn lanes) is W2951.
- **No hardcoded rider paths** — the census keys on item id → branch name,
  so it generalizes to any DONE item with a banked sha.

## Tests

`packages/suspenders/test/completion-integrity.e2e.ts` — 7 tests over
scratch worlds: clean world (exit 0, no state), dry-run detects descendant
drift (exit 1, no state, no events), `--act` banks + emits both events,
second `--act` on unchanged head is silent (idempotence), healing the
branch drops the episode, divergent history classifies `divergent`,
absent branch skipped silently. Suite: `bun --bun
node_modules/.bin/playwright test completion-integrity -c
packages/suspenders/test/playwright.config.ts` → 7 passed.
