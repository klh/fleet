# W2068 — dangling-path false positive: `scripts/hooks/session-end.ts`

## Verdict

False positive, same scanner class as W2061/W2063/W2067. Nothing is
dangling: `packages/suspenders/scripts/hooks/session-end.ts` never existed
in any tree, and the reference the scanner blamed — the
`"hooks/session-end.ts"` string in
`packages/suspenders/scripts/sync-harness.ts` (ENTRYPOINTS:39) — is
repo-relative to `packages/suspenders/`, not to `scripts/`. It resolves to
the tracked, present `packages/suspenders/hooks/session-end.ts`.

## Evidence

- `git cat-file -e HEAD:packages/suspenders/hooks/session-end.ts` →
  present.
- `git cat-file -e 6fd2b5a8:packages/suspenders/scripts/hooks/session-end.ts`
  → `fatal: path … does not exist` — the merge the item blames left
  nothing behind; the `scripts/hooks/` path never existed.
- Live validator: `sourcePaths()` (sync-harness.ts — the `payloadClosure`
  walk that refuses on any vanished face) ran clean against this worktree
  at HEAD: 27 closure roots, zero missing.
- Focused suite `bun test test/sync-harness.test.ts`: 34 pass / 2 fail —
  both fails are the W1468 kit-twin spawner tests (`:961`, `:984`),
  pre-existing and environmental (identical counts on sibling W2067's
  byte-identical tree; this delta adds one docs file only).

## Disposition

No repair needed; superseded as a no-op disposition per this doc.
Sibling dispositions of the same scanner class: W2061, W2063, W2067
(`packages/suspenders/docs/design/w206{1,3,7}-dangling-path-false-positive.md`).
The durable fix is the fleet-loop dangling-path detector (tracked as
W2172/W2173 class items), not another closure doc.
