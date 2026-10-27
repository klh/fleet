# W1833 — the `INSERT INTO facts …` "path" is a scanner false positive

## Finding

No repo path containing the item title's "missing" segment ever existed —
`git log --all -- "packages/suspenders/hooks/lib/work/INSERT INTO facts*"`
is empty on every ref, and `packages/suspenders/hooks/lib/work/` holds no
such file on any branch. The merge that produced 043636c6 dropped nothing.

## Why the reference is not dangling

The string the reference-detector parsed as a path is the inline SQL
statement literal at `packages/suspenders/hooks/lib/work/work-completion-record.ts:667`
(inside `persistCompletion`), written to the `facts` table of governor.db:

```ts
db.query(
	"INSERT INTO facts (key,value,source,version,ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts",
).run(...)
```

It is executed SQL, not a path reference — there is no file to restore, no
import to rewrite. `work-completion-record.ts` imports only existing
modules (`./work-fence.ts` and `../` siblings), and the module imports
cleanly under bun after `bun install` healed the fresh worktree's
dependency links.

## Disposition

False positive; no code change. Same scanner class as W1795–W1806,
W1820–W1823, W1824–W1830.

## Verification

- Module import probe: `await import(".../work-completion-record.ts")` → OK.
- Focused suites green: `work-completion-cross-repo` 7 pass / 0 fail,
  `lane-context` 4 pass / 0 fail, `work-knowledge` 2 pass / 0 fail.
