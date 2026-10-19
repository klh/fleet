# hn-scout second feed — best-of agent harnesses (W837)

2026-10-19 · lane autow837 · machine-local change, zero fleet code touched.

## What changed

`~/.claude/local-llm/hn-scout.ts` (machine-local per owner law; launchd
`com.suspenders.hn-scout`, 12h interval) gained a second source beside the
HN front-page scan:

- `feed.json`
  (https://ryanalberts.github.io/best-of-Agent-Harnesses/feed.json) is
  fetched every run; its newest item id (`refresh-YYYY-MM-DD`) gates the
  weekly-diff pass — already-processed ids log-and-skip.
- `harnesses.json`
  (https://raw.githubusercontent.com/RyanAlberts/best-of-Agent-Harnesses/main/harnesses.json)
  is fetched whole (`projects[]` 166 + `radar[]` 24 + `graveyard[]` 4 + meta)
  only on a new refresh id.
- Diff vs a per-slug fingerprint snapshot (description, tier/autonomy/
  recovery ranks, category, archived) stored in
  `~/.cache/claude-governor/hn-scout-state.json` → new/changed projects;
  unseen `radar` + `graveyard` github_ids also become candidates.
- Candidates are kev-classified (:8912, ≤12/run, ranked by stars) exactly
  like HN hits; lifted entries emit `finding.harness-<slug|id>` facts + one
  BROADCAST digest. kev-down fail-opens to top-6 unclassified.
- First-ever pass = baseline only (no facts, no broadcast); the snapshot
  then self-heals through the normal state path.

## Correction to research-awesome-harnesses-2026-10-18.md

That doc's sources table names "skillsllm best-of-Agent-Harnesses"; the
owner is actually `RyanAlberts` (GitHub-API verified 2026-10-19 —
`skillsllm/...` 404s). Documented here per journalism law; the original
doc is not silently edited.

## Verification (2026-10-19, live)

- baseline pass: `harness baseline: 166 projects, 24 radar, 4 graveyard @
  refresh-2026-10-18`
- skip gate: `harness: refresh-2026-10-18 already processed`
- diff pass (state rewound to `refresh-2026-10-11`, 3 slugs dropped): 2/3
  candidates lifted → `finding.harness-codex` + `finding.harness-opencode`
  facts emitted, broadcast digest out, state self-healed to 166/24/4.

Live A/B also caught a real bug: the run tail's `saveState` rebuilt the
object literal and silently dropped the new `harness` block — additive
state now spreads (`...state`). The first baseline was lost to this and
re-banked on the next pass.

## Fleet-code footprint

None (mission law: keep the loop machine-local). hn-scout has no repo
mirror; the existing launchd plist already points at the machine-local
path and needed no change.
