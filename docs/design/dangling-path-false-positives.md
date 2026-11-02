# Dangling-path scanner false positives — indexed disposition record

The post-merge dangling-path scanner (`hooks/lib/fleet-loop/dangling-paths.ts`)
banks findings into one aggregate repair item (W2172; it minted one item
per finding before). A recurring finding class is the FALSE positive: the
flagged path never dangled, so the edge closes as a no-op. Since W1795, each repair lane authored its own `docs/design/<item>-dangling-path-false-positive.md`
record — 25 near-identical files (W1795–W1841, W2063). This file replaces
them: **one indexed record, one row per item**. New false-positive closures
append a row here (the banking site's repair-item description names this
record); they do NOT mint a new per-item file. Full per-item evidence
remains in git history under the deleted `w*-dangling-path-false-positive.md`
names.

| Item | Flagged target | Why it never dangled |
| --- | --- | --- |
| W1787 | `packages/bad` in `packages/suspenders/deploy/zai-catalog.test.ts` | String-literal fixture argument to `parseZaiModelIds`, never a repo reference; `git log --all` empty; rewritten to a non-path-shaped id so the scanner stops re-firing (e2c4f06a) |
| W1788 | `zai-models.json` in `zai-catalog*.test.ts` | Machine-local runtime conf (`$HOME/.claude/local-llm/` via `zaiCatalogFile`, belt zai-catalog-rows.ts); the test literals are tmpdir fixtures; repo-path absence pinned in-suite (0006311c) |
| W1789 | `models.json` in `zai-catalog.test.ts` | `join(mkdtempSync(dir), ...)` tmpdir fixtures the test writes itself; never existed on any ref; absence pinned in-suite (6c63f3d8) |
| W1795 | `packages/suspenders/scripts/routing-policy.json` | Scanner resolves bare relative literals against the referencing file's directory (`resolveLiteral`); the string is data, not a reference |
| W1796 | `packages/suspenders/scripts/supervisor.ts` | Substring content check read as a relative import |
| W1797 | `packages/suspenders/scripts/health.ts` | The reference resolves into the runtime home (`packages/belt/bin/health.ts` exists since a8bd4a12); `scripts/health.ts` never existed in this repo |
| W1798 | `packages/suspenders/test/swarm.ts` | Test hits are runtime-home joins (`join(home, "swarm.ts")`), not repo-file references |
| W1799 | `packages/suspenders/test/supervisor.ts` | Path never existed on any branch; test hits are runtime string literals, not imports |
| W1801 | `packages/suspenders/test/new-health.ts` | Path never existed; hits are runtime fixtures (`writeFileSync(join(home, "new-health.ts"))`) |
| W1800 | `packages/suspenders/test/new-supervisor.ts` | Path never existed (empty `git log --all`); hits are runtime fixtures (`writeFileSync(join(home, "new-supervisor.ts"))` passed as the `supervisorSource` dep) — same class as W1801/W1799 |
| W1806 | `packages/suspenders/test/gen.ts` | The string is fixture data |
| W1809 | `packages/suspenders/test/oversize.ts` | Path never existed on any branch; the hit is a tmpdir fixture the test itself writes |
| W1815 | `lane-launch.ts` | The flagged string is a SQL statement |
| W1816 | `packages/suspenders/hooks/lib/lanes/lane-context.json` | Premise false — the path was never deleted; the reference is correct as-is |
| W1817 | `packages/suspenders/test/work.ts` | Path never existed; the string is a bin name for the harness spawner |
| W1818 | `packages/suspenders/test/lane-context.json` | Test builds the path at runtime; never references a repo path |
| W1819 | `continuation.txt` | No code change; no-op close with empty disposition commit for evidence (8bd04893) |
| W1820 | `packages/suspenders/test/dispatch-reclaimed-context.test.ts`→`README.md` | The reference is `join(tree, "README.md")` against a `.worktrees` tree — not the repo tree |
| W1821 | `packages/suspenders/test/lanes.json` | Path never existed in any revision |
| W1822 | (receipt; path class) | Premise false — no repair needed |
| W1823 | `packages/suspenders/test/unrelated.txt` | The string is fixture data |
| W1826 | `packages/suspenders/test/operator-stop.json` | Never a repo path; test writes it as evidence output |
| W1827 | `packages/suspenders/test/operator-reconcile.json` | Test-local evidence path via `writeFileSync(evidencePath, …)` |
| W1831 | `hooks/lib/executors/claude-runtime.ts` | Reference already correct; entrypoint-existence guard spec added |
| W1832 | `packages/suspenders/hooks/lib/work/lane-context.json` | `join()` fragments resolve to the runtime-generated `<worktree>/.fleet/lane-context.json` |
| W1838 | `packages/suspenders/deploy/*` | The export target exists; nothing to restore or rewrite |
| W1839 | `packages/suspenders/agent-rules/*` | Path exists, exports entry resolves |
| W1841 | `packages/suspenders/test/cd.worktrees/W1357 && bun test product.test.ts` | The string is command fixture data |
| W2063 | `packages/suspenders/test/oracle.ts` | Never a repo path; the only reference builds the real binary path at runtime |

## How to read a flagged item before dispositioning

1. `git log --all -- <target>` — empty history means the merge dropped
   nothing.
2. Read the referencing file at the cited line: is the literal a reference
   (ESM import / runtime path) or data (fixture string, command text,
   evidence-path write, join() fragment)?
3. Data or never-existed → close as a false positive, append one row to
   this table, done. Real dangling edge → restore the path or rewrite the
   reference, close with the focused suite green.
