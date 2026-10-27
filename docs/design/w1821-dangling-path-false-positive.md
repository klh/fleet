# W1821 — dangling-path item false positive

Item W1821 claimed `packages/suspenders/test/lanes.json` is a dangling path
referenced by `packages/suspenders/test/dispatch-reclaimed-context.test.ts`.
Premise is false:

- `packages/suspenders/test/lanes.json` never existed in any revision
  (`git log --all -- <path>` is empty).
- The test's two `lanes.json` reads (lines 66 and 214) resolve to
  `join(h.REPO, ".fleet", "lanes.json")`, where `h.REPO` is the
  `dispatchHarness` `mkdtempSync` fixture repo (`test/helpers/dispatch-harness.ts:101`)
  — the file is runtime-written there by dispatch, never a repo path.

## Verification

- Bare-harness probe: `work.ts add` in a fresh mkdtemp repo succeeds (exit 0,
  mints `W1 READY`), so the harness machinery itself is sound.
- A/B: `bun test packages/suspenders/test/dispatch-reclaimed-context.test.ts`
  fails identically at this tree and at the untouched baseline merge
  `c5d42437` in a detached `/tmp` rig (3 fail, all in the harness
  `addItem` expect) — a pre-existing environment artifact, not caused by and
  unrelated to any dangling path.

Disposition: no repair needed; nothing restored, rewritten or superseded
beyond this receipt.
