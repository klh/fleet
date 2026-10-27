# W1840 — `packages/suspenders/test/bun test product.test.ts` is a scanner false positive

## Finding

`packages/suspenders/test/bun test product.test.ts` never existed in git
history (`git log --all -- <path>` is empty on every ref). The merge that
produced 043636c6 deleted nothing — zero `D` entries — and is the commit
that ADDED the referencing file
`packages/suspenders/test/claim-check-copilot.test.ts`.

## Why the reference is not dangling

`claim-check-copilot.test.ts` names `"bun test product.test.ts"` three
times (lines 14, 53, 54): the default `command` of the `call()`
transcript-event builder and two rows of the `test.each` list of direct
test commands the Copilot claim-check parser must recognize. Each
occurrence is a bash command fixture ("run `bun test` on
`product.test.ts`"), not a path. The W1302.2 scanner literal-captured the
quoted string and joined it onto the containing directory —
`packages/suspenders/test/` + `bun test product.test.ts`. Same class as
W1806 (`gen.ts`), W1815, W1818, W1819, W1820–W1823.

## Disposition

False positive; no code change. There is no repo path to restore and no
reference to rewrite — the string is command fixture data feeding
`transcriptEventsFromText` / `claimCheckVerdict`.

## Verification

- `git log --all -- "packages/suspenders/test/bun test product.test.ts"`
  is empty.
- `git diff --name-status 043636c6^1 043636c6` — zero `D` entries; the
  merge added the referencing file and modified only siblings.
- Focused suite green: `bun test packages/suspenders/test/claim-check-copilot.test.ts`
  — 55 pass / 0 fail, 113 expect() calls; imports resolve (the suite
  imports `../hooks/lib/gates/claim-check.ts`).
