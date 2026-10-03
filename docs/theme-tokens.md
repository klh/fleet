# klh theme tokens — dark/light contract (W269)

One theme layer for every klh GUI: the suspenders board (`/`), console pages
(`/console/*`), `/usage`, and — copied verbatim — the belt and klh-local
dashboards. Source of truth: `hooks/lib/theme.ts` (tests: `test/theme.test.ts`).

## Contract

- `<html data-theme="dark|light">` selects the palette. Components style with
  `var(--klh-*)` only — never a literal color. (Categorical data hues, e.g. the
  `/usage` model-group series, are data, not chrome, and stay fixed.)
- `<html data-theme-pref="light|dark|system">` mirrors the user's choice.
- Preference persists in `localStorage["klh-theme"]` (`light` | `dark`;
  absent = `system`). No server round-trip.
- `system` resolves through `prefers-color-scheme` and follows live OS flips.
  Without JS (or matchMedia) the page is dark — the historical look.
- No flash of wrong theme: the pre-paint script runs in `<head>`, before the
  first `<style>` that consumes tokens and before `<body>` paints.
- `window.klhTheme` = `{ pref(), resolve(pref), apply(), set(pref) }`.
  `set("system")` clears the key.
- Every apply dispatches `klh-themechange` on `document` with
  `detail: { theme, pref }` — canvas/chart code redraws on it (see
  `hooks/bin/usage-charts.ts`: uPlot strokes are functions reading
  `--klh-chart-*`, so a `redraw()` is all a theme flip needs).
- Other tabs follow via the `storage` event.

## Adopting it in another GUI

1. In `<head>`, first thing after `<meta charset>`: `THEME_HEAD`
   (`<style id="klh-theme-tokens">…</style><script>…pre-paint…</script>`).
   Non-TS GUIs: serve the output of
   `bun -e 'import {THEME_HEAD} from "./hooks/lib/theme.ts"; console.log(THEME_HEAD)'`.
2. Replace palette literals with tokens (table below). Do not keep a
   `:root { color-scheme: … }` of your own — the token block sets it.
3. Add the settings region to the top bar (markup below) plus
   `THEME_SETTINGS_CSS` and, after the markup, `THEME_SETTINGS_JS`.

## Settings region markup

`settingsBlock(extra)` emits this (gear SVG elided); `extra` is where a GUI
appends its own fieldsets/links — the console adds
`<a href="/console/settings">all console settings →</a>`:

```html
<details class="klh-settings" id="klh-settings">
  <summary aria-label="settings" title="settings"><svg>…gear…</svg></summary>
  <div class="klh-settings-panel" role="group" aria-label="settings">
    <fieldset class="klh-theme">
      <legend>theme</legend>
      <label><input type="radio" name="klh-theme" value="light" /> light</label>
      <label><input type="radio" name="klh-theme" value="dark" /> dark</label>
      <label
        ><input type="radio" name="klh-theme" value="system" checked />
        system</label
      >
    </fieldset>
    <!-- extra: GUI-specific settings -->
  </div>
</details>
```

Native `<details>` gives keyboard + screen-reader disclosure for free;
`THEME_SETTINGS_JS` only binds the radios to `klhTheme.set`, re-syncs them on
`klh-themechange`, and closes the panel on outside click / Escape. No DOM is
constructed — no `innerHTML`.

## Tokens

| token               | dark                    | light                  |
| ------------------- | ----------------------- | ---------------------- |
| `--klh-bg`          | `#141413`               | `#f6f4ef`              |
| `--klh-field`       | `#121110`               | `#ffffff`              |
| `--klh-panel`       | `#171614`               | `#fbfaf7`              |
| `--klh-surface`     | `#1c1b19`               | `#ffffff`              |
| `--klh-overlay`     | `#1a1917`               | `#ffffff`              |
| `--klh-surface-hi`  | `#232220`               | `#ece9e2`              |
| `--klh-ink`         | `#e8e6e1`               | `#1c1b19`              |
| `--klh-ink-2`       | `#c3c2b7`               | `#3b3934`              |
| `--klh-ink-3`       | `#a5a29a`               | `#55524b`              |
| `--klh-dim`         | `#98958e`               | `#6b675f`              |
| `--klh-accent`      | `#d8900f`               | `#a86a00`              |
| `--klh-on-accent`   | `#141413`               | `#ffffff`              |
| `--klh-accent-bg`   | `#221f14`               | `#fbf1dc`              |
| `--klh-accent-wash` | `rgba(216,144,15,.12)`  | `rgba(168,106,0,.10)`  |
| `--klh-warm`        | `#221f1c`               | `#f8efe4`              |
| `--klh-danger`      | `#af2f12`               | `#af2f12`              |
| `--klh-danger-ink`  | `#c96a4f`               | `#a3361a`              |
| `--klh-danger-bg`   | `#221512`               | `#fbe9e4`              |
| `--klh-danger-edge` | `rgba(175,47,18,.6)`    | `rgba(175,47,18,.5)`   |
| `--klh-danger-wash` | `rgba(175,47,18,.16)`   | `rgba(175,47,18,.10)`  |
| `--klh-ok`          | `#5c7a35`               | `#5c7a35`              |
| `--klh-ok-ink`      | `#7da652`               | `#3f6a1c`              |
| `--klh-ok-hi`       | `#a5c78a`               | `#35591a`              |
| `--klh-ok-bg`       | `#1a2015`               | `#eaf3e0`              |
| `--klh-ok-wash`     | `rgba(92,122,53,.18)`   | `rgba(92,122,53,.14)`  |
| `--klh-info`        | `#8cbbad`               | `#2f7a68`              |
| `--klh-wash`        | `rgba(255,255,255,.03)` | `rgba(0,0,0,.025)`     |
| `--klh-edge-faint`  | `rgba(255,255,255,.07)` | `rgba(0,0,0,.07)`      |
| `--klh-edge-soft`   | `rgba(255,255,255,.10)` | `rgba(0,0,0,.10)`      |
| `--klh-edge`        | `rgba(255,255,255,.12)` | `rgba(0,0,0,.13)`      |
| `--klh-edge-mid`    | `rgba(255,255,255,.18)` | `rgba(0,0,0,.18)`      |
| `--klh-edge-strong` | `rgba(255,255,255,.24)` | `rgba(0,0,0,.24)`      |
| `--klh-edge-hover`  | `rgba(255,255,255,.4)`  | `rgba(0,0,0,.4)`       |
| `--klh-rule`        | `#2c2c2a`               | `#e2dfd8`              |
| `--klh-shadow`      | `rgba(0,0,0,.5)`        | `rgba(0,0,0,.14)`      |
| `--klh-chart-grid`  | `#2c2c2a`               | `#e2dfd8`              |
| `--klh-chart-hair`  | `#383835`               | `#cfcbc2`              |
| `--klh-chart-axis`  | `#898781`               | `#6b675f`              |

Roles: `bg` page base · `field` text inputs · `panel` top bar / sunk panels ·
`surface` cards · `overlay` drawers · `surface-hi` raised chips/avatars ·
`ink` → `ink-3` → `dim` text emphasis ladder · `accent` interactive amber,
`on-accent` text on an accent fill · `edge-*` borders by strength · `rule`
table dividers · `danger*` / `ok*` / `info` status families.

Lit components consume the same names (custom properties pierce shadow DOM),
e.g. `klh-decision-eval` uses `--klh-surface`, `--klh-ink`, `--klh-edge`,
`--klh-accent`, `--klh-dim`.
