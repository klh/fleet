# W2063 — dangling path `packages/suspenders/test/oracle.ts` is a false positive

## Finding

`packages/suspenders/test/oracle.ts` was never a repo path. `git log --all --
packages/suspenders/test/oracle.ts` is empty. The only `oracle.ts` reference
in `packages/suspenders/test/oracle.test.ts` is a string literal at :16
building the path to the real binary:

```ts
const ORACLE = join(import.meta.dir, "..", "hooks", "bin", "oracle.ts");
```

That target exists (`packages/suspenders/hooks/bin/oracle.ts`). The test
imports nothing from a sibling `./oracle` — its imports are `bun:test`,
`node:fs`, `node:os`, `node:path`. The merge that produced 72ed4767 dropped
nothing; there is nothing to restore and no reference to rewrite.

## Disposition

Item closed as a no-op. The focused suite ran green (12 pass / 0 fail,
`bun test test/oracle.test.ts`, 2.71s) at the closing sha. Same
false-positive class as the closed siblings W1807 (`"flood.ts"`), W1826
(`operator-stop.json`) and the W1795–W1804 batch.
