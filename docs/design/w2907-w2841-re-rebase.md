# W2907 — re-rebase of suspenders/W2841 onto the current main lineage

W2841 parked the chord-vendor accommodation line: scrub-gate accommodations
for standard HTTP phrases in the vendored chord sources, the FORK.md
vitest-policy note (upstream suite vendored pristine, fleet CI stays
bun-only), and — via its own earlier merge of suspenders/W2832 at the branch
tip — the knowledge-distill evolution (settings.distill.ts plus the
jobs-llm/runner/sink trio under hooks/lib/knowledge/distill/). The original
branch could not clear the merge ladder, so this item merges the parked
content into the main lineage; the ladder lands `suspenders/W2907` in place
of the original.

## How it landed

Same `/private/tmp` throwaway-worktree recipe as W2906 (the
/Volumes/Sensitive mount-sync `.git`-directory artifact makes in-worktree
git ops flap; `lesson.sensitive-volume-gitdir-mirror-artifact`).

- `79ee7efc` — merge of `parked/W2841`: sole conflict bun.lock, resolved to
  main's tree plus a lockfile-only regen over the merged manifests. The
  corpus files ride in as plain adds (identical blobs to the already-landed
  vendoring), and `.gitleaksignore` gains the same line-inspected
  chord-fixture entries used by the sibling merges (RFC 6455 spec sample
  Sec-WebSocket-Key, synthetic archive.jsonl fixture UUIDs).
- `06ee5062` — merge of `suspenders/W2902`: the fork-exemption wiring
  (FORKS/FORK_TREES, KNOWN_DEAD import-law pin) plus the gitleaks entries;
  `.gitleaksignore` resolved to the superset (the chord block covers both
  lineages' needs), bun.lock rebalanced.

## What proves it

The five knowledge-distill suites (decant, graph, run, sync, verify) run
against the merged distill trio; the root law, import-law, and
knob-registry guards pass; the pre-push gate (verb contract, coverage
collection, check-p1, scrub + secrets push scans) accepted the branch,
and `suspenders/W2907 @ <tip>` is on origin for the ladder.
