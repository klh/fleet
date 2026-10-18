# W725 — re-mint of W279 ruled duplicate of landed work

2026-10-18, lane `autow725-p98b319584008df14`, branch `suspenders/W725`.

## Disposition

W725 was minted 2026-10-12 from a stale verification: belt/bin was searched
at `f2f5602a` (suspenders/W695.9) and reported no e-label/decision-label
mapping. W279 landed 2026-10-15 — `aa51eede` "router e-label mapping —
serving-tier detectors + label-first placement", merged as `f9c73b80` — and
is an ancestor of this branch's HEAD. Re-implementing would duplicate
landed work, so W725 closes on verification evidence, not new code.

## What already exists (verified at HEAD `70d57c20`)

- `classifyELabel` / `eLabelSpecial` in `packages/belt/bin/router-core.ts`:
  serving-tier detectors (none/cloud/coder/general-language/reason), 32k
  cloud threshold, translation + language regex, complexity fallback.
- `packages/belt/bin/router-shim.ts`: e-label decided per request and
  carried on `_routing.category`; label-first placement remaps (reason/
  extract); cloud-decided requests escalate before the local ladder; kev
  guard unchanged.
- `packages/belt/bench/arena/legs.ts`: `routedTier` scores the DECISION
  (category-first for TIERS keys).

## Test evidence

- `test/w279-router-e-labels.test.ts` — 17 pass / 0 fail.
- All 9 router suites (policy, shim-parity, tools, w257, w270, w304, w6959,
  w732, w279) — 111 pass / 0 fail. One first-run failure was fresh-worktree
  dependency resolution (`@klh/blam` unresolved until `bun install --force`
  at the worktree root); all green after relink.

## Residual note

W279's child `W279.1` (FAILED 2026-10-11, lanes died in the litellm-alias
window) carried no scope beyond the parent; the parent's full scope is what
`aa51eede` delivered. No follow-up work item is minted from this re-mint.
