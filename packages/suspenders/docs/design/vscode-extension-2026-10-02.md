# VS Code extension — the fleet board, user-perspective (W216)

> Status: SHIPPED with W216. Source of truth for the extension contract;
> board API contract stays in docs/board-api.md.

## Principle

The v3 board spec's rule — "the GUI centres on your task and the
coordinator's decisions, with agent machinery underneath" — applied to the
IDE: the extension is **not** an iframe of the web board. It is native VS
Code UI that answers the owner's three questions while they code:

1. What is the fleet doing right now? (Working lanes)
2. What is queued for it? (Ready work)
3. What needs **me**? (Open decisions)

Full machinery (drawer, usage, setup, executor dropdowns) stays one click
away: the web board opens deep-linked to the same item (`#task=<id>` /
`#decision=<id>`), in the browser.

## Layout

- `vscode/` — self-contained sub-package (own package.json + lockfile; the
  root lockfile never gains vscode dev-deps).
  - `src/api.ts` — pure board client (fetch, no `vscode` import; types for
    the `/api/tasks` + `/api/decisions` shapes).
  - `src/model.ts` — pure tree/status model (grouping, labels, truncation).
  - `src/extension.ts` — thin activation wiring (providers, poll loop,
    commands, status bar). No logic that tests need.
  - `src/*.test.ts` — bun tests over fixtures captured from the live board.
  - `scripts/pack.ts` — bun entry point: `bun build` → out/extension.js,
    then assembles a vsix (zip of extension.vsixmanifest +
    [Content_Types].xml + extension/) via `zip` with argument arrays.
  - `icon.svg` — 24×24 monochrome activity-bar glyph.
- `dist/` under the extension dir is the vsix output (gitignored).

## Data flow

`serverUrl` (default `http://localhost:7799`) + `refreshSeconds` (default 15) in workspace/user settings (`suspendersFleet.*`). One poll loop fetches
both feeds; providers + status bar consume the snapshot; failures degrade
to a "board unreachable" node, never a thrown error into the UI.

## Non-goals (v1)

No webview, no write actions (no start/stop from the IDE — the web board
owns dispatch), no activity feed (it is a firehose; the web board is one
click away).
