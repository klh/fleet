# W2069 — dangling path `packages/suspenders/scripts/hooks/pre-compact.ts` is a false positive

## Finding

`packages/suspenders/scripts/hooks/pre-compact.ts` was never a repo path —
`git log --all -- <path>` is empty and `git cat-file -e 6fd2b5a8:<path>`
fatals, so the merge that produced 6fd2b5a8 dropped nothing. The reference
the scanner flagged is the string literal `"hooks/pre-compact.ts"` in
`packages/suspenders/scripts/sync-harness.ts:40` (`ENTRYPOINTS`, W253
checkpoint-roll comment). That list is package-root-relative — see
`CLOSURE_ENTRIES`, which prefixes each entry with
`packages/suspenders/` (`sync-harness.ts:62`) — and resolves to the tracked,
present `packages/suspenders/hooks/pre-compact.ts` (same false-positive
class as siblings W2063 and W2067: the scanner mis-attributed an
ENTRYPOINTS string as `scripts/`-relative).

## Verification

- Real validator: `sourcePaths()` (payloadClosure over CLOSURE_ENTRIES,
  refuses on vanished faces) ran clean against HEAD — 27 faces,
  0 missing.
- Focused suite: `bun test packages/suspenders/test/sync-harness.test.ts`
  — 34 pass / 2 fail; both fails are the W1468 kit-twin spawner tests,
  environmental and pre-existing at HEAD (file byte-identical; this
  branch's only delta is this doc).

## Disposition

Item closed as a no-op: nothing to restore, no reference to rewrite.
