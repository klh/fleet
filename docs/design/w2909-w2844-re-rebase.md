# W2909 — re-rebase of suspenders/W2844 onto the current main lineage

Parked/W2844 carries the chord + pi-durable vendoring (the cockpit durable-
session foundation), the cockpit design-doc corpus, W2857.1/W2267.5 board
work, and the p1 pin re-stamp. The merge ladder refused the original branch
(git merge-tree failure); this re-rebase lands it on origin/main 64348ea6 in
a /private/tmp worktree (mount-sync-immune tree).

## Merge 1 — parked/W2844

CLEAN merge — the ladder's merge-tree failure did not reproduce against the
current main (it likely bit against the older main). No conflicts; bun.lock
auto-merged (36,623 → 59,830 bytes with the vendored manifests).

## Merge 2 — suspenders/W2902 (fork-exemption stack)

One conflict: `packages/buckle/src/citizenship.ts` — the inverse geometry of
the W2908 case: main carries the W914 registry-derived block but no
`/v1/workers` row; the stack carries the combined `/repo-policy/manifest ||
/v1/workers` hand row but no registry block. Resolved to the union: the
hand row stays above the registry block (registry has no workers row yet —
grep confirmed). bun.lock auto-merged.

## Vendored-corpus accommodations

- The stack's FORKS carve-out already covers `packages/chord/` +
  `packages/pi-durable/`: 341 vendored `*.test.ts` ride exempt through the
  W1294 test-framework ratchet (merged tree counts 572 with them included,
  570 without).
- The two buckle W914 suites re-introduced by the W2843 content riding
  W2844's history (`endpoints.test.ts`, `litellm-ops.test.ts`) are NOT
  vendored and pushed the count to 572 > pin 570. Ported to the tagged
  convention — byte-restored from the proven W2908 landing (same transform
  this session: `@unit.e2e.ts` rename, `@playwright/test` imports, describe
  unwrapped; the bun loader resolves @playwright/test with no `describe`
  named export). Count lands exactly at the 570 pin; 20/20 green under the
  buckle config in this tree.
- W902 wall-clock law: the fleet-authored `pi-extensions/fleet-awareness/
panel.ts` rendered runner event times with a bare `toLocaleTimeString()`.
  Fixed to the dualShort vocabulary (`hooks/lib/wallclock.ts`) — fleet code,
  not vendored, so the law applies; no allowlist entry. Law-guard suite
  green after the fix.

## Proofs

- root: law-guards 14 green; import-law + knob-registry green in the
  combined run; test-framework + import-resolution bun-test guards green
  (count at pin); the ported buckle suites 20/20 green.
- qlty on-save gates passed on every touched file; scrub clean.
- Record at docs/design/w2909-w2844-re-rebase.md; pushed as
  suspenders/W2909.
