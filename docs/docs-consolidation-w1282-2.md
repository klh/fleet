# Docs consolidation follow-up — W1282.2 (2026-10-25)

Scope: tracked `docs/**/*.md` on this branch. The dated records remain in
place; current work state still comes from `work show` and current code.

| Cluster | Before | After and retained evidence |
| --- | --- | --- |
| [Research synthesis](research-toto-gpt.md#enterprise-starter-sharing-across-hubs-and-developers) and [starter architecture](starter-registry-architecture.md) | The research synthesis copied 114 lines of the artifact, cache, promotion, and two-hub design already held in the architecture file. The architecture introduction still claimed none of its features were implemented. | Replaced the copied design with an 11-line route to the canonical architecture and [W458.6 milestone receipt](../packages/suspenders/docs/starter-milestone-w458-6.md). The canonical record now distinguishes W458.1–.5 library code and tmpdir 26/26 proof from unproved live dispatcher materialization, network distribution, and production cache savings. Provider cache source links moved there. |
| [W975 Settings delivery](decision-w975-settings-json-policy.md) and [W996 duplicate closure](decision-w996-settings-structured-forms.md) | W996 restated W975's controls, migration, and three test receipts in 40 lines. | W996 is 12 lines: it retains the no-code duplicate decision and its unique validation/secrets checks, while W975 remains the implementation receipt. |
| [Research link](research-toto-gpt.md) after the reorg | `lane-retry-budget.ts` pointed to the former flat `hooks/lib` path. | Link now points to `hooks/lib/lanes/lane-retry-budget.ts`, matching current imports. |

`research-toto-gpt.md` changed from 1,268 to 1,165 lines (103 fewer);
W996 changed from 40 to 12 (28 fewer). The net reduction across those two
records is 131 lines. No historical document path was removed.

The local Markdown target scan covers every `docs/**/*.md` file, including
the new links in this receipt and the map. It checks file existence, not remote
URLs or fragment anchors. Run from the repo root:

```sh
bun -e 'import {globSync,readFileSync,existsSync} from "node:fs"; import path from "node:path"; const bad=[]; let links=0; for (const file of globSync("docs/**/*.md")) { const s=readFileSync(file,"utf8"); for (const m of s.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) { links++; const u=m[1].split("#")[0]; if (!u || /^[a-z]+:/i.test(u) || u.startsWith("#")) continue; if (!existsSync(path.resolve(path.dirname(file),u))) bad.push(`${file}:${s.slice(0,m.index).split("\n").length} -> ${u}`); }} console.log(JSON.stringify({links,broken:bad},null,2));'
```

Result: `{"links":165,"broken":[]}`. The pre-edit scan found 149 links and
one missing local target, the moved retry-budget module.
