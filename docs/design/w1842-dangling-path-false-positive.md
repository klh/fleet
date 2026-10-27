# W1842 — dangling path `packages/suspenders/test/jest product.test.ts`: false positive

Scanned 2026-10-27 · lane autow1842-p98b319584008df14 · merge 043636c6

## Finding

The item flagged `packages/suspenders/test/jest product.test.ts` as missing
while `claim-check-copilot.test.ts` "still references it
(`jest product.test.ts`)". The premise is false:

- The path never existed on any ref: `git log --all -- "packages/suspenders/
  test/jest product.test.ts"` is empty, including `--diff-filter=D`.
- Merge 043636c6 deleted nothing on this surface — it **added** the
  referencing file (`claim-check-copilot.test.ts`, 531 new lines) plus the
  copilot evidence recognizer; `--diff-filter=D` on the merge is empty.
- The "reference" is a jest CLI command fixture:
  `packages/suspenders/test/claim-check-copilot.test.ts:59` sits in the
  `test.each` list of recognized direct test commands (alongside
  `"pnpm test"`, `"vitest run"`, `"cargo test"`). It is recognizer input
  data, not an import or path literal.

## Mechanism

The post-merge dangling-path scan
(`hooks/lib/fleet-loop/dangling-paths.ts`, probe 2 `unresolvedSpecifiers`)
extracts every quoted string ending in a `.ts`-like suffix (PATH_LIKE),
then `resolveLiteral` joins it against the containing directory:
`join("packages/suspenders/test", "jest product.test.ts")` → the flagged
target. The sibling rows in the same list (`"bun test product.test.ts"`,
`"node --test product.test.ts"`) are the identical shape and got their own
items (W1840 et al.).

The runtime copy that minted this item predates two scoping guards the
shipped detector has since fixed (W1302.2.1):

- `REFERENCE_FORM` — only dot-prefixed (`./`, `../`) or `@klh/` specifiers
  are judged; bare command strings like `jest product.test.ts` are skipped
  (`REFERENCE_FORM` match: `false` for this literal).
- `FIXTURE_FILE` — files under `test/` or matching `*.test.ts` are excluded
  from probe 2 entirely.

## Verification

Repro against the real module at HEAD, plus the merge-history checks above:

    unresolvedSpecifiers(repo, "HEAD", [claim-check-copilot.test.ts]) → []
    REFERENCE_FORM.test("jest product.test.ts") → false
    resolveLiteral("jest product.test.ts", refBy)
      → "packages/suspenders/test/jest product.test.ts"  (mechanism only)

Focused suite (imports resolve, recognizer behavior intact):

    cd packages/suspenders && bun test test/claim-check-copilot.test.ts
    # 55 pass, 0 fail, 113 expect() calls

## Disposition

No restore, no rewrite — the string is correct recognizer fixture data and
the referencing file plus its import
(`../hooks/lib/gates/claim-check.ts`) are intact. Docs-only close,
mirroring W1806/W1815/W1818–W1840.
