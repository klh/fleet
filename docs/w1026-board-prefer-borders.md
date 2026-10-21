# W1026 — Board card borders follow project `.prefer`

Landed 2026-10-21 as `2e780122` (merged to main via `92604a78`), branch
`suspenders/W1026`.

## What changed

`.kcard` borders now follow the live project `.prefer` color instead of the
semantic state color:

- `.kcard` / `.kcard:hover` / `.kcard.ksel` border rides
  `var(--prefer, var(--state-color, …))` — the `.prefer` color owns the edge
  when present, state hue is the fallback.
- The W-918 inset-stripe variant (`box-shadow:inset 3px 0 …`) is retired.
- Semantic state colors stay visible where they belong: state pills
  (`data-tone` → `--state-color`) and the column top border are untouched.

## Verify

```
cd packages/suspenders && bun test test/board-prefer.test.ts
```

5 pass / 0 fail (12 expects). CSS asserts cover border, hover, selected and
pill color-lock lines in the shipped `fleet-board-html.ts` chunk.
