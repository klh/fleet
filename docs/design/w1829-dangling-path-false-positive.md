# W1829 — `packages/suspenders/hooks/board/.fleet/brief-<sid>.md` is a scanner false positive

## Finding

`packages/suspenders/hooks/board/.fleet/brief-<sid>.md` never existed in git
history (`git log --all -- 'packages/suspenders/hooks/board/.fleet/'` is empty
on every ref). Merge b269924f (suspenders/W1810 → HEAD, 2026-10-27) dropped
nothing — its only change is a 1-line edit inside `launch-context.ts` itself.

## Why the reference is not dangling

`packages/suspenders/hooks/board/launch-context.ts:35`:

```ts
return join(canonicalProjectRoot(project), ".fleet", `brief-${sid}.md`);
```

`briefFileFor` is a runtime path builder, not a repo-path reference: it
resolves into the project's **primary checkout** `.fleet/` (via
`canonicalProjectRoot`), where the dispatch shim persists each lane's brief at
launch (`scripts/dispatch-next.ts` writes the same bytes it feeds the lane).
Those briefs are real and present at runtime — e.g.
`.fleet/brief-autow92-3.md` in the primary checkout — but they are untracked
runtime state, never repo paths. The scanner heuristic-joined the specifier
against the source file's directory.

Even if a brief is absent (manual takes, pre-brief lanes), the read at
`launch-context.ts:47-49` is `existsSync`-guarded with a labeled `item`/`none`
fallback — the reference is designed to tolerate the file being missing.

## Disposition

False positive; no code change. There is no repo path to restore and no
reference to rewrite. Same class as W1791/W1795-W1801/W1806 and
W1821/W1823-W1827 (W1824's receipt names the scanner-class source fix as the
durable remediation).

## Verification

- `git log --all -- 'packages/suspenders/hooks/board/.fleet/'` is empty.
- Merge b269924f touches only `launch-context.ts` (1 line).
- Focused `launch-context` suite green (counts in the item close summary).
