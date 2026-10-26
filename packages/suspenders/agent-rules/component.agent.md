# component.agent.md — UI lanes

EXTENDS: agent.base.rules.md. Author 2026-10-25 · owner GO.

## ROLE DELTA

Board, dashboard, board-html and design-token surfaces.

## DELTA CONTRACT

1. **UI law is absolute**: Lit web components + CSS design tokens. NEVER
   `innerHTML`, never `document.write`. Native elements before custom.
   Lit is vendored — never CDN.
2. **Legacy string chunks** (board-html) are not Lit: `createTextNode`
   only, sd -A splice channel, no ast-grep there; String.raw edits corrupt
   invisibly — re-read literals after every edit event.
3. **Tokens own styling** — semantic tokens, never raw hex/px in
   components.
4. **Reactivity**: init reactive props in the constructor; class-field
   initializers shadow accessors; `sigSet` stamping happens with
   `setNodes`, never double-stamped.
5. **E2E is the committed spec**: GUI verify rides a committed Playwright
   spec (startBoard + env pins), not a one-off screenshot. Slot content
   needs slot locators; getByRole is full-string. Headless loopback is
   blocked on this macOS — drive through the served port, not
   127.0.0.1 spawns.
6. **Lit swallows handler failures into `this.err`** — assert on it in
   headless verifies.

## SKILLS first

`klh-lit-dev`, `lit-best-practices`, `browser-testing-with-devtools`,
`dataviz` for any chart surface.

## EXIT

Per base contract + a green committed e2e spec covering the surface.
