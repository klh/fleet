# Docs consolidation receipt — W1282.1 (2026-10-25)

Base: `a07a6ee1` on `suspenders/W1282.1`. Scope: tracked `docs/**/*.md` at
that commit. This is a content and link audit, not a new work-status ledger.
The work graph remains authoritative for current item state.

| Cluster inspected | Repeated material | Disposition and retained evidence |
| --- | --- | --- |
| [Monorepo audit](monorepo-audit-2026-10-05.md), [integration review](monorepo-review-2026-10-05.md), [research synthesis](research-toto-gpt.md), [corpus audit](md-corpus-audit-w693.md) | The synthesis repeated the review's six findings, installed BLAM failure, and test count. | Replaced the copied table with one baseline paragraph and direct links. The review keeps each finding and reproduction; the corpus audit keeps later landing checks. |
| [Identity design](cross-hub-project-identity.md), [observability architecture](upstream-observability-architecture.md), [research synthesis](research-toto-gpt.md) | The synthesis repeated migration order, downstream hub visibility, trace/read-model design, and IoT comparisons. | Replaced four repeated subsections with a compact summary and direct links. Kept the synthesis's isolated-clone observation and explicit research/deployment boundary; detailed source anchors and comparisons remain in the dedicated records. |
| [Failed backlog triage](failed-backlog-triage-2026-10-12.md), [W785 sweep](w785-skipped-postponed-forgotten-sweep-2026-10-18.md), [W782 sweep](review-w782-skipped-sweep-2026-10-19.md), [W805 closure](stale-failed-close-sweep-2026-10-18.md) | Some item IDs and findings recur. | Preserved all four dated receipts: their item states and owner decisions differ by date. [The map](README.md) now gives reading order and points to `work show <id>` for current state. |

## Measured change

- `research-toto-gpt.md`: 1,345 lines at base, 1,268 after consolidation
  (77 fewer). Its detailed research outside the two duplicate clusters remains.
- The corpus had 10 broken relative Markdown targets before repair: eight
  `docs/` prefixes or repo-root paths in `research-toto-gpt.md`, one stale
  `lane-retry-budget.ts` location there, and one `benchmarks.md` path in
  `decant-crosscheck-2026-10-19.md`. A scan of all `docs/**/*.md` now finds
  146 links and zero missing local targets. It checks target files, not remote
  URLs or fragment-anchor semantics.
- [The documentation map](README.md) has 42 working local links. No historical
  record was deleted or moved, so existing inbound document paths remain.

The local-target scan was run from the repository root:

```sh
bun -e 'import {globSync,readFileSync,existsSync} from "node:fs"; import path from "node:path"; const bad=[]; let links=0; for (const file of globSync("docs/**/*.md")) { const s=readFileSync(file,"utf8"); for (const m of s.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) { links++; const u=m[1].split("#")[0]; if (!u || /^[a-z]+:/i.test(u) || u.startsWith("#")) continue; if (!existsSync(path.resolve(path.dirname(file),u))) bad.push(`${file}:${s.slice(0,m.index).split("\n").length} -> ${u}`); }} console.log(JSON.stringify({links,broken:bad},null,2));'
```

Result: `{"links":146,"broken":[]}`. Before repair it reported 10 missing
targets: `decant-crosscheck-2026-10-19.md:6` and
`research-toto-gpt.md:5,948,973,990,1012,1030,1245,1265,1274` on the
pre-condensation version. Those line numbers identify the source snapshot, not
the edited file.

This audit uses the checkout at the named base. The concurrent W1283 monorepo
reorganization may change paths after this commit; its final diff needs its own
link check before integration.
