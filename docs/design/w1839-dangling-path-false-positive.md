# W1839 — `packages/suspenders/agent-rules/*` is a scanner false positive

## Finding

`packages/suspenders/agent-rules/` exists on this branch and in history: it
was added in ee92e895 ("agent-rules: role library suspenders launches agents
with (base + 8 role files, zero repetition)") and carried through the merge
that produced 043636c6 — the merge dropped nothing. `eza` lists all ten
files (README, agent.base.rules.md, code.agent.md, component/deploy/doc/
test.agent.md, governor.rules.md, reviewer.rules.md, supervisor.rules.md).

## Why the reference is not dangling

`packages/suspenders/package.json:45` declares
`"./agent-rules/*": "./agent-rules/*"` and `:52` lists `agent-rules` in
`files`. Both resolve: a `Bun.file().exists()` probe over the exports map
substituting a real role file (`code.agent.md`) for the glob confirms
`./agent-rules/*` resolves to an existing file. The other glob exports
(`./hooks/*`, `./scripts/*`, `./deploy/*`) resolve the same way for their
own contents; the probe's raw "MISSING" lines for them are an artifact of
substituting a markdown filename where those globs expose `.ts`/script
files, not evidence of dangling paths.

## Disposition

False positive; no code change. The path exists, the exports entry
resolves, nothing to restore or rewrite — same class as W1806, W1815,
W1816, W1817, W1818, W1819, W1821, W1823 (fleet-loop dangling-path
heuristic, event class `code.dangling-path` with `line:0`).

## Verification

- `bun test packages/suspenders/test/agent-rules.test.ts` — 9 pass /
  0 fail (41 expect calls) on this branch.
- `git log --all -- packages/suspenders/agent-rules` shows the directory
  was created, never deleted.
