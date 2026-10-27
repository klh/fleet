# W2061 — dangling-path item was a scanner false positive (no defect)

Item W2061 ("Repair dangling path packages/suspenders/hooks/bin/s VERDICT
matches review-lane.ts referenced by packages/suspenders/hooks/bin/oracle.ts")
was minted by the post-merge dangling-path scan
(`hooks/lib/fleet-loop/dangling-paths.ts`) from a **comment**, not from any
import or runtime path string.

## Mechanism

`oracle.ts:74` reads:

```
// machine-parseable (review's VERDICT matches review-lane.ts's parse).
```

The scanner's quoted-literal regex (`LITERAL`,
`/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g`) pairs apostrophes: the `'` in
`review's` opens a capture that closes at the `'` in `.ts's`, yielding the
"literal" body `s VERDICT matches review-lane.ts`. That body passes
`PATH_LIKE` (ends in `.ts`) and fails tree existence, so the scan minted a
repair item whose target is prose — the mangled item title is the captured
body verbatim.

## Why there is nothing to repair

- `packages/suspenders/hooks/bin/review-lane.ts` exists at HEAD (tracked;
  last touched `dca36d6b` / `7e2c076f`).
- `oracle.ts` carries exactly ONE mention of `review-lane` — the comment
  above. No import, no `new URL(...)`, no runtime path string. The W832
  contract reference is descriptive prose.
- The same false-positive family is dispositioned in W2063
  (`docs/design/w2063-dangling-path-false-positive.md`, sibling lane) and
  W1807; the durable fix is a scanner guard (comment stripping and/or a
  git-history existence check before minting), tracked separately — not a
  per-item repair.

## Evidence

- `rg -n "review-lane" packages/suspenders/hooks/bin/oracle.ts` → exactly
  line 74, the comment.
- `ls packages/suspenders/hooks/bin/review-lane.ts` → exists.
- Focused suites after `bun install` in the fresh worktree:
  `bun test test/oracle.test.ts test/review-lane-proof.test.ts` →
  **30 pass / 0 fail** (207 expect calls, 2 files).

Disposition: supersede-as-no-op. No code changed; this document is the
record.
