# W2747 — rebase record: parked/W2607 onto main

Merge commit cd8795a2 on `suspenders/W2747` (base = main c580c624). The
ladder could not land `suspenders/W2607` itself (merge-tree conflict vs
main); this branch carries the merge resolved against current main and
lands in its place.

## Situation

`parked/W2607` (tip bdb50cec, via the parked/W2504 lineage, 3 commits
ahead of merge-base 12e6cc62) holds the W927 contrastive-consults work.
Main independently landed the same W927 content at a35b4ae9 (W2286:
merge parked/W2228, 2026-10-29), so the conflict is same-content drift,
not competing features.

## Overlap audit (15 files touched by parked/W2607)

- 10 files byte-identical to main already (contrastive.ts,
  contrastive-selection.ts, consult.ts, facts.ts, shared.ts, bin/coord.ts,
  contrastive-helpers.ts, consult-contrastive.spec.ts, kev-stub fixtures).
- route-preflight(.test).ts: main supersedes via W2633 (W2630 hotfix +
  B1 review fix) — kept main.
- govdb-open.ts, kb.ts: main ahead (publish_grants DDL, W2605-merge
  comment wording) — kept main.

## Conflict resolved (1 file)

| File | Resolution |
| --- | --- |
| `packages/suspenders/hooks/coord/kb.ts` | kept main's comment wording (`W927 (W2605 merge)` — the newer landed lineage) over parked's older `W2504 (W927 re-land)` wording; both describe the same `refused`/`contrastive` counters |

## Net tree delta vs main

`git diff c580c624..suspenders/W2747 --stat` → 1 file
(`packages/suspenders/hooks/lib/knowledge/knowledge-facts.ts`, 5+/3−):
parked's bf1d53b4 qlty-fmt canonical wrapping (multiline
`PRAGMA table_info` cast), semantically identical — main never received
that fmt pass.

## Verification

- merge pre-commit gate: scrub clean, 100 pass / 0 fail across 11 files.
- playwright `knowledge-facts@unit.e2e.ts` → 4 passed.
- playwright e2e `consult-contrastive.spec.ts` (chromium config) →
  7 passed.
