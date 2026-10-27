# W2066 — dangling-path finding is a false positive

Item: "Repair dangling path packages/suspenders/scripts/hooks/gate.ts referenced by
packages/suspenders/scripts/sync-harness.ts" (minted by the W1302.2 post-merge
dangling-path scan).

## Disposition

Nothing to restore or rewrite; superseded as a false positive.

- `packages/suspenders/scripts/hooks/gate.ts` never existed — `git log --all
  --oneline -- <path>` is empty across every ref.
- The finding's `target` is a phantom built by the scanner's probe 1
  (danglingReferences → resolveLiteral), which resolves a hit literal relative to
  the REFERENCING FILE's directory. sync-harness.ts:37's `"hooks/gate.ts"` is an
  ENTRYPOINTS entry whose base is `packages/suspenders/` (line 62:
  `...ENTRYPOINTS.map((entry) => \`packages/suspenders/${entry}\`)`), not the
  referencing file's own dir. The real `packages/suspenders/hooks/gate.ts` exists
  at HEAD (7.7k, continuous history).
- The scanner's probe 2 (unresolvedSpecifiers, W1302.2.1) already excludes bare
  `dir/name.ext` strings for exactly this reason; probe 1's grep-form expansion
  (`refForms` tail-2 form "hooks/gate.ts") still greps them, then misresolves the
  hit through the referencing file's dir. Same class as W2061/W2063.

## Evidence

- `git cat-file -e HEAD:packages/suspenders/hooks/gate.ts` → exists;
  `HEAD:packages/suspenders/scripts/hooks/gate.ts` → "does not exist".
- Import graph: `Bun.build({entrypoints:
  ["packages/suspenders/hooks/gate.ts"], target: "bun"})` → success (the same
  validate() leg sync-harness.ts runs over ENTRYPOINTS).
- Focused suites `bun test test/sync-harness.test.ts test/w1302-merge-dangling.test.ts`:
  48 pass / 2 fail — both failures are the W1468 runtime-twin drift tests
  (belt/bin/spawner.ts runtime-home twins, machine-local state), unrelated to
  gate.ts and present on the untouched baseline tree.
