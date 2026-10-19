# W866 — fleet tree tag: `tag = "fleet"`, `color = "#5D4157"`

Owner GO 2026-10-19: fleet items get the Kaimurasaki (Kamakura purple)
color on the board — lane-card borders + task-list dots for every item of
the fleet tree.

## Decision

The repo-root `.prefer` is machine-local tree config (globally gitignored
via `~/.config/git/ignore` — config-over-code law, like the scrub
denylist). The tag therefore lands as a LIVE file edit, not a tracked
artifact:

```
# W517 tree tag (owner GO 2026-10-19, W866) — Kamakura purple
tag = "fleet"
color = "#5D4157"
```

Appended below the existing executor-chain block (`must=` ladder +
`prefer=` pin, 2026-10-12) — the two planes share one file by design;
`tag`/`color` are foreign keys to both other planes (W519).

## Plane split (verified against the lib)

- `hooks/lib/prefer.ts` (W517): tag/color plane — quoted values, one key
  per line, first wins. The appended lines parse clean.
- `scripts/lib/exec-chain.ts`: executor chain — only reads
  `must`/`prefer`/`can`/`hub`; `tag`/`color` ignored.
- `scripts/lib/prefer-routing.ts` (W519): routing plane — `tag`/`color`
  are FOREIGN_KEYS, never an error.
- Board: `hooks/board/data.ts` `taskShape` resolves per project root
  (5s TTL) → `tag` + `tag_color` on every fleet row; `board-html/tasks.ts`
  renders the `.pdot` dot + `.kcard` `--prefer` border token.

## Known noise (tracked as W868)

The W517 parser flags the executor ladder's repeated `must=` lines as
"set more than once" — legal in the executor plane (W813 repeats +
comma-lists, later wins). W868 adopts the W519 plane split in prefer.ts.

## Verification

```
bun -e 'import { resolvePrefer } from "packages/suspenders/hooks/lib/prefer.ts";
console.log(resolvePrefer("/Volumes/Sensitive/github/klh/fleet"))'
# → tag: "fleet", color: "#5D4157" — no errors attributable to the appended lines
```

Board /api/data fleet rows then carry `tag: "fleet"`,
`tag_color: "#5D4157"` (≤5s TTL) and the tasks view dots/borders follow.

## Applied (2026-10-19, lane autow866 re-dispatch)

The block was appended to the machine-local, gitignored repo-root
`.prefer` (idempotent append; executor-plane `must=`/`prefer=` lines
untouched) and verified live on this machine:

- `resolvePrefer` on the fleet root → `tag: "fleet"`,
  `color: "#5D4157"`, `errors: []` — W868's plane split keeps the
  executor ladder silent.
- Live board `/api/tasks?project=<fleet>/.git` → all 992 rows carry
  `tag: "fleet"`, `tag_color: "#5D4157"`; the tasks-view `.pdot` dots and
  kanban `--prefer` card borders render the Kaimurasaki color.
