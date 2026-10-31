# @klh/design-ui

Shared UI foundations (W2269.1.1) — the ONLY home for shared UI primitives.
Consuming slices (W2269.1.2/.3/.4) adopt these; nothing outside this package
mints new shared token/event/style plumbing.

## Tokens

- Sources: `src/tokens/primitives/*.json` (raw palette/space/type/motion),
  `src/tokens/semantic/*.json` (roles: surface/ink/muted/edge/accent/
  status-*/focus + the W2267.1 board page tokens, NAMES KEPT), and
  `src/tokens/themes/{light,high-contrast}.json` (`:root` = dark default).
- Build: `bun src/tokens/build.ts` emits `src/tokens/dist/tokens.css`
  (`:root` + `[data-theme]` overrides), typed `dist/tokens.ts`
  (`TOKENS` / `TokenName`), and per-theme `dist/themes/<t>.css`.
- The build runs the WCAG AA contrast check over every text/surface pair in
  every theme; a failing pair exits 1 — never a silent ship.
- Import faces: `@klh/design-ui/tokens` (css), `@klh/design-ui/themes/*`,
  the typed module via `@klh/design-ui` barrel or
  `@klh/design-ui/src/tokens/dist/tokens.ts`.

## Events kit

`KlhEvent` base (bubbles + composed default true). Typed subclasses with
`static readonly type`, typed readonly payload fields (never
`CustomEvent.detail`), `HTMLElementEventMap` augmentation per domain module
(`klh-theme.events.ts` is the seed domain). Naming:
`<noun>-<verb>-requested` (please do this; the mediator decides) or
`<noun>-<past tense>` (this happened).

## SCSS → Lit styles

`src/build/scss-plugin.ts`: `compileStylesheet(path)` → CSS text,
`emitStylesModule(scss, out)` → a Lit `static styles` module. One
stylesheet per component, sass exact-pinned (1.107.1); CSS custom
properties carry the theme through shadow DOM at runtime.

## Register pattern

`defineElement(tag, ctor)` — the ONE registration door; a double define
fails loudly. Modules export classes; a single register.ts per workspace
calls defineElement.

## Catalog

`catalog/index.html` skeleton: component next to its native prototype,
light and dark, swatches fed from the typed token names. Deep catalog
detail lands in W2269.1.5.
