# W2906 — re-rebase of suspenders/W2840 onto the current main lineage

W2840 carried the settings centralization (W2760/W2824): the llm-conf
extraction (`packages/settings/src/settings.llm-conf.ts` + its suite), the
stack.ts env-ladder rows, and a regenerated `settings.schema.json`. The
original branch could not clear the merge ladder (merge-tree failed against
main), so this item merges the parked branch content into the main lineage
directly; the ladder lands `suspenders/W2906` in place of the original.

## How it landed

Work ran in a `/private/tmp` throwaway worktree because the
/Volumes/Sensitive mount-sync materializes a `.git` directory artifact over
worktree `.git` pointer files inside `.worktrees/` — in-worktree git ops
flap between a corrupt mirror (stale main HEAD, vanishing edits, staged
stale content) and the restored pointer within seconds. Recovery recipe is
banked fleet-wide as `lesson.sensitive-volume-gitdir-mirror-artifact`
(`coord fact get lesson.sensitive-volume-gitdir-mirror-artifact`).

- `b47824bb` — merge of `parked/W2840` (W2840's unique payload):
  - `packages/settings/src/index.ts` resolved to the superset union: the
    branch's llm-conf export block plus main's `settings.runner.ts` export
    block.
  - `packages/settings/settings.schema.json` regenerated from the merged
    zod (`settingsJsonSchemaText()`), so the committed JSON matches the
    merged schema exactly (the committed-copy test enforces this).
  - `bun.lock` rebalanced via `bun install --lockfile-only` over the
    merged package manifests.
  - `.gitleaksignore` gained the line-inspected chord-fixture entries
    (RFC 6455 spec sample Sec-WebSocket-Key and synthetic archive.jsonl
    fixture UUIDs, owner `fixture.switch.owner` — reviewed upstream fixture
    material, no real credential).
- `281688a6` — merge of `suspenders/W2902`: the fork-exemption wiring
  (FORKS/FORK_TREES ratchet exemptions, KNOWN_DEAD import-law pin, gitleaks
  entries) that lets the vendored chord/pi-durable/blam corpus clear the
  test-framework and import-law guards while it rides toward the ladder.

## What proves it

The settings package suite runs against the merged tree (the committed
schema copy is byte-current with the merged zod); the root law, import-law,
and knob-registry guards pass; the pre-push gate (verb contract, coverage
collection, check-p1, scrub + secrets push scans) accepted the branch, and
`suspenders/W2906 @ 281688a6` is on origin for the ladder.
