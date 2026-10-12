# W659 — W656 verb-kit wave 1: batch map (executed record)

W659 was minted as the plan item for W656 wave 1 (the dry-up campaign
retiring hand-rolled `process.argv` parsing in hooks/bin one-off CLIs onto
`defineVerb`). The batches materialized under W656 itself — W656.1/.2/.3,
all DONE with result shas — so W659 closes as the batch-map record, not a
re-split. Batches are independent file sets; no script appears in two
batches; no shared edits.

## Order and scope

Order A → B → C is the shatter order: A first (auth/security-adjacent
CLIs, highest blast radius), B the misc one-offs, C the family clusters
(federation + policy). Each batch = one commit under `hooks/bin`, plus a
regression suite pinning the preserved CLI faces.

### Batch A — W656.1 (commit 1fb48d84)

8 scripts: `admission`, `approve-destructive`, `auth`, `claim`,
`lifecycle-authority`, `progress`, `scrub-gate`, `splice` — all
`packages/suspenders/hooks/bin/*.ts`. Suite: `test/verb-kit-batch-a.test.ts`
(9591599b; 6 kit help faces + 2 second-person minters + one real verb per
CLI with preserved exit codes). Suite commit message records the two
pre-existing fails proven via detached A/B at baseline 348a853.

### Batch B — W656.2 (commit e0bf5af5)

8 scripts: `advise`, `worktree`, `soak`, `packet-prep`, `copilot-usage`,
`morph`, `quota-window`, `credit-forecast`. Suite:
`test/verb-kit-batch-b.test.ts` (+ `morph.test.ts`).

### Batch C — W656.3 (commit de9e5e7a)

6 scripts: `federation-peers`, `federation-pull`, `federation-report`,
`policy-advisor`, `policy-workflow`, `metrics-alert`. Suites touched:
`test/verb-kit.test.ts`, `test/policy-advisor.test.ts`.

Two of batch C's 8 listed candidates were judged non-CLIs at execution and
stay out of wave 1, same rule that excluded the servers:

- `fallback-drill.ts` — not a CLI: imported drill lib run from llm-keepwarm
  (no argv face, no usage string to retire).
- `federation-usage-html.ts` — board-side HTML emitter module, not a
  one-off CLI (W656's "servers, not CLIs" exclusion).

## Independence (no shared edits)

The three commits' file sets under `hooks/bin` are disjoint — 8 + 8 + 6
distinct filenames, verified from each commit's `--name-only`. No batch
edited a file another batch touched.

## Verification

All three result shas (9591599b, e0bf5af5, de9e5e7a) and the migration
commits (1fb48d84, e0bf5af5, de9e5e7a) are ancestors of main
(`git merge-base --is-ancestor`, checked 2026-10-12). 24 `hooks/bin` files
currently import `defineVerb` (`rg -c`), the wave-1 22 plus the
grandfathered kit riders.
