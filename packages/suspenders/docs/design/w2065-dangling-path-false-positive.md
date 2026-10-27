# W2065 — dangling-path item was a scanner false positive (no defect)

Item W2065 ("Repair dangling path packages/suspenders/test/note.md referenced
by packages/suspenders/test/oracle.test.ts") has nothing to repair:
`packages/suspenders/test/note.md` never existed in the repo.

## Evidence

- `git log --all -- packages/suspenders/test/note.md` → empty; no commit in
  any ref ever tracked the path. It was not deleted by the merge that
  produced `72ed4767` (or any other): `git log --all --diff-filter=D` for
  the path is also empty.
- The sole "reference" is `oracle.test.ts:248`:
  `const file = join(dir, "note.md")` — `dir` is a `mkdtempSync` tmpdir
  fixture root and line 249 writes the file (`writeFileSync(file, ...)`)
  before `oracle analyze --in` reads it. It denotes a synthetic tree, the
  exact case the scanner's W1302.2.1 fixture scoping exists to exclude; the
  probe reached a bare `.md` basename via the `refForms` reference forms,
  and no repo-tree path was ever implied.

## Disposition

Same false-positive family as W2061, W2063 and W1807 (apostrophe-paired
prose literals / fixture temp paths). No path to restore, no reference to
rewrite. Focused suite after verification:
`bun test packages/suspenders/test/oracle.test.ts` → 12 pass / 0 fail.
The durable fix is a scanner guard (git-history existence check and/or
fixture-tree exclusion for runtime-written temp paths), tracked separately
as W2172 — not a per-item repair.
