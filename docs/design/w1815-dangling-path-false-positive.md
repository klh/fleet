# W1815 — the `lane-launch.ts` "dangling path" is a SQL statement

## Finding

The item's target "path"
`packages/suspenders/hooks/lib/fleet-loop/INSERT INTO facts(key,value,source,version,ts) VALUES (?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,source=excluded.source,version=version+1,ts=excluded.ts`
is not a path at all — it is the bun:sqlite upsert string at
`packages/suspenders/hooks/lib/fleet-loop/lane-launch.ts:982`, joined onto
the file's own directory. `lane-launch.ts` references itself; nothing is
missing from the tree (`ls packages/suspenders/hooks/lib/fleet-loop/` lists
`lane-launch.ts`; the item predates no deletion).

## Why the scanner flagged it

`pathLiterals` keeps any quoted literal matching `PATH_LIKE`, whose second
alternative is any string ending in `.ts` — and the SQL ends with
`…version=excluded.ts`. The scan that minted this item (merge c5d42437) ran
before/at the W1302.2.1 reference-form scoping; the CURRENT scanner
(`unresolvedSpecifiers`) requires dot-prefixed or `@klh/` specifiers, and no
literal in `lane-launch.ts` passes that filter anymore — so this class is
not re-minted by the live code.

## Disposition

False positive; no code change. There is no path to restore and no
reference to rewrite — the string is a SQL statement, and the reference
(target = refBy = the same file) resolves trivially.

## Verification

- `bun -e` probe: `pathLiterals(lane-launch.ts body)` yields the SQL string;
  `resolveLiteral` joins it onto `packages/suspenders/hooks/lib/fleet-loop/`
  exactly reproducing the item's target, while the current
  `unresolvedSpecifiers` reference-form filter rejects it.
- Focused `w1302-merge-dangling` suite green (counts in the close summary).
