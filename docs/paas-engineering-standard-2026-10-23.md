# TypeScript PaaS Monorepo — Engineering Standard

Oct 23, 2026 · @klaus l. hougesen

This is the house standard for a TypeScript PaaS monorepo: platform APIs first, schemas first, one obvious way to do each thing, and every rule enforced by a check rather than by memory.

## Principles

1. **Native first.** Semantic HTML and platform APIs (`fetch`, `URLPattern`, `<dialog>`, `ElementInternals`, `Intl`, `crypto`) before any library.
2. **Boring and inspectable.** Small hand-written modules over frameworks. If a dependency can't be read in an afternoon, it doesn't go in.
3. **Composed, never monolithic.** Small files with one job each, DRY across the whole repo. No file passes 1500 lines; one approaching that limit stops work until it is decomposed.
4. **Stateless by default.** Components and modules are pure functions of their inputs. State comes from composition (mediators, context) or the data layer, never from inside a leaf.
5. **Schema first.** Zod defines every data shape; TypeScript types are derived from the schemas, never written by hand.
6. **Events up, data down.** Components announce what happened; mediators decide what to do. Side effects live only in mediators and services.
7. **One test framework.** Every test runs on `@playwright/test`, browser or not; load tests rerun the same specs under a load project.
8. **Semantic errors, one handler.** A small fixed set of error kinds flows unchanged from service to HTTP to UI.
9. **Good HTTP citizen.** Correct status codes, conditional requests, idempotency, load shedding, honest retries.
10. **Every folder is a package, installed strictly.** Each declares exactly what it imports, at an exact version. No parent-directory resolution, no floating ranges.
11. **Same shape everywhere.** Same file naming, same folders, same config, same formatter defaults.
12. **Config off-repo.** Real hosts, keys and limits live in machine-level config; the repo carries `*.example` placeholders only.

## Repository layout

Four top-level groups of workspaces (`apps`, `services`, `packages`, `design`) plus `infra`, `tools` and cross-package `tests`. No workspace sits inside another workspace's folder.

```
paas/
├── package.json               # workspaces list + scripts only; NO dependencies
├── package-lock.json          # committed; CI runs npm ci
├── .npmrc                     # install-strategy=linked, save-exact=true, engine-strict=true
├── .prefer.example            # harness lock-down template; real .prefer is machine-local
├── .editorconfig
├── tsconfig.base.json         # strict shared compiler options
├── tsconfig.json              # editor entry only; each package type-checks with its own
├── .qlty/qlty.toml            # qlty init defaults, untouched
├── AGENTS.md                  # repo-wide rules (CLAUDE.md -> @AGENTS.md)
├── README.md
│
│   every directory marked [pkg] has its own package.json and installs via npm
│
├── apps/
│   ├── console/               # [pkg] @paas/console: web dashboard
│   │   ├── src/
│   │   │   ├── events/        # domain events (app-deploy-requested ...)
│   │   │   ├── mediators/     # apps, deploys, shell, error: the only side effects
│   │   │   ├── features/      # presentational components built from patterns
│   │   │   ├── debug/         # <console-debug-panel>
│   │   │   ├── pages/
│   │   │   └── main.ts
│   │   ├── playwright.config.ts
│   │   ├── e2e/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── README.md
│   ├── cli/                   # [pkg] @paas/cli: bin paas (deploy | logs | env set)
│   └── docs/                  # [pkg] @paas/docs: markdown -> static site
│
├── services/                  # each deployable on its own; each ships a bin
│   ├── api/                   # [pkg] @paas/api: bin paas-api, the only front door
│   │   ├── src/
│   │   │   ├── routes/
│   │   │   ├── middleware/    # request-context, auth, error-handler
│   │   │   └── server.ts      # Bun.serve
│   │   └── playwright.config.ts
│   ├── builder/               # [pkg] @paas/builder: source -> OCI image
│   ├── scheduler/             # [pkg] @paas/scheduler: desired state -> placements
│   ├── agent/                 # [pkg] @paas/agent: per node, run containers, report state
│   ├── router/                # [pkg] @paas/router: domains, TLS, routing table
│   ├── logs/                  # [pkg] @paas/logs: NDJSON ingest + streaming
│   └── health/                # [pkg] @paas/health: outside-process probe sidecar
│
├── packages/                  # shared libraries
│   ├── contracts/             # [pkg] @paas/contracts: Zod schemas, codecs, types, OpenAPI
│   ├── sdk/                   # [pkg] @paas/sdk: typed client over contracts
│   ├── errors/                # [pkg] @paas/errors: semantic error kinds + problem+json
│   ├── debug/                 # [pkg] @paas/debug: namespaced, leveled logging
│   ├── http/                  # [pkg] @paas/http: server-side HTTP correctness
│   ├── resilience/            # [pkg] @paas/resilience: timeouts, retries, breaker, failover
│   ├── db/                    # [pkg] @paas/db: SQL, migrations, row codecs
│   ├── auth/                  # [pkg] @paas/auth: tokens, scopes, audit
│   ├── config/                # [pkg] @paas/config: machine-config loader
│   └── testing/               # [pkg] @paas/testing: fixtures, in-process harness
│
├── design/                    # the design system, one layer per package
│   ├── tokens/                # [pkg] @paas/tokens: json -> scss + css vars + ts
│   ├── scss/                  # [pkg] @paas/scss: abstracts, base, layout
│   ├── html/                  # [pkg] @paas/html: native semantic prototypes (stage 1)
│   ├── events/                # [pkg] @paas/events: typed UI event vocabulary
│   ├── foundations/           # [pkg] @paas/foundations: controllers, a11y helpers
│   ├── elements/              # [pkg] @paas/elements: paas-* primitives (stage 2)
│   ├── patterns/              # [pkg] @paas/patterns: composed components (stage 3)
│   ├── mediators/             # [pkg] @paas/mediators: form, selection, shortcut
│   ├── icons/                 # [pkg] @paas/icons
│   ├── build/                 # [pkg] @paas/design-build: SCSS -> Lit styles plugin
│   └── catalog/               # [pkg] @paas/catalog: prototype + component side by side
│
├── infra/
│   ├── compose/               # [pkg] @paas/infra-compose: compose files + bin paas-stack
│   ├── images/                # [pkg] @paas/infra-images: Dockerfiles + bin paas-images
│   └── environments/          # [pkg] @paas/infra-environments: schema + *.example.yaml
│
├── tools/                     # [pkg] @paas/tools: TypeScript on Bun, no shell scripts
│   ├── package.json           # bin: paas-dev, paas-release, paas-gen-openapi, paas-check
│   └── src/
│       ├── dev.ts
│       ├── release.ts
│       ├── gen-openapi.ts
│       ├── check-deps.ts
│       ├── check-boundaries.ts
│       ├── check-versions.ts
│       ├── check-pack.ts
│       └── check-ui-laws.ts
│
├── tests/                     # [pkg] @paas/tests (private): e2e + law guards
└── .github/workflows/ci.yml
```

### Package contract

Everything under `apps/`, `services/`, `packages/`, `design/`, `infra/` and `tools/` is an npm package: it packs with `npm pack` and installs with `npm install` into an empty folder outside the repo.

| Field | Rule |
| --- | --- |
| `name` | `@paas/<name>`, unique across the repo |
| `version` | The repo version, plain `MAJOR.MINOR.PATCH` |
| `type` | `"module"` |
| `exports` | Explicit map; nothing importable that isn't listed |
| `files` | Explicit allowlist (`src`, `README.md`, assets); tests never ship |
| `bin` | Every runnable (services, CLI, tools, infra helpers) exposes one |
| `dependencies` | Exact versions, including sibling `@paas/*` packages |
| `engines` | Pinned `bun` and `npm`; packages ship TypeScript source and run under Bun |
| `publishConfig` | The private registry; `private: true` only for `@paas/tests` |

Every package also has the same shape: `src/` (code, specs and `fixtures/` side by side, named per Composition and file naming), `playwright.config.ts` built from `@paas/testing`, `tsconfig.json`, and a `README.md` stating its purpose and public API.

**Installed, not mounted.** Service images install their own package (`npm install @paas/api@1.4.0`) and run its `bin`; they never copy the monorepo in. Non-code packages (`infra-*`, `html`, `scss`, `tokens`) ship their files through `files` and expose them through `exports`, so consumers resolve them by package name.

**`tools/src/check-pack.ts` proves it:** packs every package, installs each tarball (plus its `@paas/*` dependency tarballs) into a scratch folder outside the repo, and imports every `exports` entry and runs every `bin --help`. A hidden parent-path dependency fails here, because outside the repo there is no parent to walk up to.

## Composition and file naming

Every file does one job and is named for it: `<namespace>.<thing>.<role>.<ext>`, so a folder listing reads as the module's structure.

```
design/patterns/src/table/
├── paas.table.base.ts            # base: stateless render of its properties
├── paas.table.base.scss
├── paas.table.sortable.ts        # variant: extends base, adds sort intent events
├── paas.table.selectable.ts      # variant: extends base, adds selection events
├── paas.table.zod.ts             # schemas for properties/events + derived types
├── paas.table.flow.ts            # shared steps when several specs need the same sequence
├── paas.table.sortable.e2e.ts    # @playwright/test spec, uses fixtures + flow
├── paas.table.selectable.e2e.ts
├── index.ts                      # barrel: the folder's public exports, nothing else
└── fixtures/
    ├── rows.data.json            # data fragments for fixtures
    └── table.fragment.html       # markup fragments mounted by the e2e
```

| Role suffix | Contains | Rules |
| --- | --- | --- |
| `.base.ts` | The base component or module | Stateless; only properties in, events out |
| `.<variant>.ts` | A variant | Extends or composes the base; adds one capability |
| `.zod.ts` | Zod schemas and the types derived from them | No logic beyond schemas and codecs |
| `.codec.zod.ts` | Wire/domain codecs (contracts) | Parse in / parse out only |
| `.map.ts` | Pure domain transforms (contracts) | No I/O, no Zod calls |
| `.flow.ts` | Plain `async (page, input) => ...` steps | Imported by specs; only when two or more specs share the steps |
| `.e2e.ts` | `@playwright/test` spec | Uses shared fixtures and flows, never raw setup |
| `.scss` | Styles for the same-named file | Semantic tokens only |
| `index.ts` | Barrel | Re-exports only; no code, no side effects |
| `fixtures/*.data.json`, `*.fragment.html` | Test data and markup fragments | Validated against the `.zod.ts` schema when loaded |

### Composition rules

- **Hard limit 1500 lines per file,** enforced on write and in CI.
- **Near-cap at 1200 lines: stop.** Before adding anything, decompose by responsibility, run `qlty smells` and `ast-grep` across the whole repo for duplicates, and refactor them into a shared module. Then continue.
- **DRY on the second duplicate,** across packages, not just within a file. The shared version goes to the lowest package both callers may import.
- **Stateless leaves.** Components render from properties and emit events; modules are pure functions. State lives only in mediators, `@lit/context` providers, and the data layer (`@paas/db`, the SDK). A stateless unit is tested by giving it input and checking output.
- **Variants compose; they don't fork.** A variant extends the base or wraps it, never copies it.
- **Barrels stay thin.** `index.ts` defines a folder's public surface; package `exports` point at barrels; nothing deep-imports past them.
- **Published packages exclude tests:** `files` leaves out `*.e2e.ts`, `*.flow.ts` (unless exported for other packages' tests) and `fixtures/`.

## Packages and installs

Installs use **npm workspaces with the linked (isolated) install strategy**, so a package can only resolve what its own `package.json` declares. The old Lerna-bootstrap goal, without Lerna.

```ini
# .npmrc
install-strategy=linked
save-exact=true
engine-strict=true
```

**No parent path walks.** Node resolution walks up directories, so isolation alone isn't enough. Three rules close the gap:

1. **The root `package.json` has no `dependencies` or `devDependencies`.** It lists workspaces and scripts only, so there is nothing at the root to walk up to. Shared dev tools (qlty runners, playwright) live in the `tools` or `tests` workspace.
2. **Imports by package name only.** `import { App } from '@paas/contracts'`, never `../../packages/contracts/src`. Relative imports may not leave their own workspace.
3. **`tools/check-deps.ts` fails CI** when any file imports a package not declared in its own workspace's `package.json` (phantom dependency), or declares one it never imports.

**Versions are exact, everywhere.**

| Where | Rule | Example |
| --- | --- | --- |
| External deps | Exact version; no `^`, `~`, `*`, `x`, `latest`, ranges or tags | `"zod": "4.1.12"` |
| Internal deps | Exact version of the sibling workspace | `"@paas/contracts": "1.4.0"` |
| Toolchain | `packageManager` + `engines` pinned | `"packageManager": "npm@11.6.2"` |
| Lockfile | Committed; CI runs `npm ci`, never `npm install` |  |

The example version numbers are placeholders; pin whatever is current when you set up the repo.

**Plain semver only.** Every version is `MAJOR.MINOR.PATCH` digits, matching `^\d+\.\d+\.\d+$`: no pre-release or build suffixes (`-beta`, `-rc.1`, `+build`). Unreleased work lives on a branch, not in a version string.

**One version for the whole repo** (Lerna "fixed" mode). `tools/src/release.ts` bumps every workspace and every internal dependency in one commit, then tags `v1.4.0`. No workspace ever drifts from the others.

**Runtime and installer are separate on purpose.** npm installs and locks; Bun runs, tests and builds from the installed `node_modules`. Don't mix in `bun install`, which would write a second lockfile.

## Git workflow

Every piece of work gets its own worktree and branch, and history on `main` stays linear: rebase, never merge commits from feature branches.

**Worktrees live next to the repo, not inside it.** A worktree under the main checkout would let Node resolution walk up into the main checkout's `node_modules`, which breaks the isolation above.

```
~/code/paas-tree/             # tree root: holds the machine-local .prefer
├── .prefer                    # covers the checkout AND every worktree below
├── paas/                      # main checkout, stays on main
└── paas.worktrees/
    ├── feat-deploy-retry/     # git worktree add ../paas.worktrees/feat-deploy-retry -b feat/deploy-retry
    └── fix-etag-412/
```

Each worktree runs its own `npm ci`; worktrees never share `node_modules`.

**Git settings** (repo-local, set by `tools/src/dev.ts setup`):

| Setting | Value | Why |
| --- | --- | --- |
| `pull.rebase` | `true` | No merge commits from pulling |
| `rebase.autoStash` | `true` | Rebase with uncommitted work safely |
| `rebase.updateRefs` | `true` | Stacked branches move together |
| `fetch.prune` | `true` | Deleted remote branches disappear locally |
| `core.hooksPath` | `.githooks` | Committed hooks run for everyone |

**Before every push:**

1. `git fetch origin`
2. `git rebase origin/main`, squashing fixups so every commit builds and passes tests on its own.
3. Run the checks (`qlty check`, `npx playwright test --project=smoke, then --only-changed=origin/main`).
4. `git push --force-with-lease` on your own branch only. Never force-push `main` or a shared branch.

`main` accepts fast-forward or rebase merges only (set in the forge's branch protection). When the branch has landed, remove the worktree with `git worktree remove` and delete the branch.

## Tooling config

Three files decide how all code looks and type-checks, and nobody tunes them per package.

**qlty: defaults, untouched.** Run `qlty init`, accept what it detects, commit `.qlty/`. Don't add per-rule overrides or per-package exceptions; if a default really hurts, change it once at the root in a reviewed PR. Day to day: `qlty fmt` on changed files, `qlty check` in the pre-push hook and CI.

**.editorconfig**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
max_line_length = 100

[*.md]
trim_trailing_whitespace = false
```

**tsconfig.base.json**: strict, modern, no emit (Bun runs TypeScript directly; `Bun.build` bundles).

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  }
}
```

**Per-workspace tsconfig.json** extends the base and adds only what its runtime needs:

| Workspace kind | Adds |
| --- | --- |
| `services/*`, `apps/cli`, `tools`, `packages/*` (server-side) | `"types": ["bun"]` |
| `apps/console`, `design/*` | `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"experimentalDecorators": true`, `"useDefineForClassFields": false` (Lit's documented decorator setup) |
| Isomorphic `packages/*` (contracts, errors, debug) | Nothing: no DOM, no Bun types, so they stay usable on both sides |

`tools/src/check-boundaries.ts` type-checks each workspace with its own tsconfig (`tsc -p <workspace> --noEmit`).

## Harness lock-down: .prefer

A `.prefer` file at the tree root pins which LLM executors and hubs the agent harness may use for any work under it. It is machine-local and globally gitignored (config off-repo); the repo carries only a documented `.prefer.example`.

**Resolution walks upward** from the working path and covers everything below it, across repo boundaries; the nearest definition wins per key. Worktrees must therefore sit inside the tree the `.prefer` covers (see Git workflow).

One file, two planes, told apart by value shape:

| Plane | Value shape | Keys | Rule |
| --- | --- | --- | --- |
| Executor chain | Unquoted single token, `key=value` | `must`, `prefer`, `can`, `hub`, `hub-url` | Later lines win: the chain head is the **last** directive; comma lists try left first |
| Tree / routing | Quoted, `key = "value"` | `tag`, `color`, `prefer`, `must` | First definition per key wins; quoted `prefer` is a soft routing expression, quoted `must` is reserved (validated, not enforced yet) |

| Directive | Meaning |
| --- | --- |
| `must=<model or hub>` | Owner intent. Never silently rerouted by allow-lists or quota health; surfaced loudly instead |
| `prefer=<model>` | Soft. Placed below a `must=`, it is tried first and the `must` becomes the fallback |
| `can=<model or hub>` | Developer override: when the target is usable on this machine, the `must=` lines are set aside for this run |
| `hub=<label>` | Pin the whole chain to a hub; an unreachable hub degrades to local, loudly |
| `hub-url=<url>` | Extra hub endpoint candidates, tried first |
| `tag = "x"` / `color = "#RRGGBB"` | Work-graph tag and board colour for everything in the tree |

Example for this repo's tree root (placeholder values):

```ini
# ~/code/paas-tree/.prefer: machine-local, never committed
# executor chain: last line = tried first
must=claude-sonnet-5
must=claude-opus-5-5
prefer=glm-5.3-flash
hub=desktop

# tree plane
tag = "paas"
color = "#2F6F8F"
```

Read bottom-up: `glm-5.3-flash` first, then `claude-opus-5-5`, then `claude-sonnet-5`, all through the `desktop` hub.

The reference format, fully commented, is fleet's `packages/suspenders/examples/prefer.example`; the parsers are `scripts/lib/exec-chain.ts` (chain), `hooks/lib/prefer.ts` (tag/colour) and `scripts/lib/prefer-routing.ts` (routing).

## Dependency budget

The whole repo has seven external dependencies: three at runtime (`lit`, `@lit/context`, `zod`) and four for build and test (`sass`, `typescript`, `@types/bun`, `@playwright/test`). Everything else is the platform or a small module written here.

| Need | Use | Not |
| --- | --- | --- |
| UI components | Custom elements + `lit` | React, Vue, Angular, Svelte |
| State | Properties down, events up, mediators, `@lit/context` | Redux, MobX, Zustand, signal libraries |
| Routing (console) | `URLPattern` + `history` + `popstate`, \~50 lines | Router frameworks |
| Styling | SCSS (`sass`, Dart Sass) + CSS custom properties | Tailwind, CSS-in-JS runtimes |
| Forms | `<form>`, `FormData`, `ElementInternals`, Zod | Form libraries |
| Dialogs, popovers | `<dialog>`, `popover`, `<details>` | Headless UI kits |
| HTTP server | `Bun.serve` + route table | Express, Nest, Fastify |
| HTTP client | `fetch` + `AbortSignal` | axios, ky |
| Validation | `zod` | yup, class-validator, io-ts |
| Database | `Bun.sql` / `bun:sqlite`, SQL by hand, row codecs | ORMs |
| Migrations | Numbered `.sql` files + \~100-line runner | Migration frameworks |
| Queues | Postgres table queue (`FOR UPDATE SKIP LOCKED`) | A broker, until load proves it |
| Logging | `@paas/debug`, NDJSON to stdout | winston, pino |
| Tests | `@playwright/test` for every test, load included | bun test, jest, vitest |
| Build | `Bun.build` + the SCSS plugin | webpack, vite plugin stacks |
| Dates, i18n | `Date`, `Intl.*` | moment, date-fns, i18n frameworks |
| IDs, crypto | `crypto.randomUUID()`, `crypto.subtle`, `Bun.password` | uuid, bcrypt bindings |

**Adding a dependency** means a PR that edits the allowlist in `tools/src/check-deps.ts` and states which platform API it replaces and why that isn't enough. It must be small enough to read and fork, with few dependencies of its own.

**Write the small version first.** Routers, retry helpers, migration runners are each under 100 lines with tests. Reach for a library only when the hand-written version gets painful.

**Front-end code is bundled, never loaded from a CDN.** Lit comes from the exact-pinned npm package and ships inside the console bundle.

## UI: native first, then Lit, then compose

Every component starts as plain semantic HTML in `design/html/`, becomes a Lit component that renders that same markup, and only then is composed into patterns and features.

| Stage | Where | Output | Done when |
| --- | --- | --- | --- |
| 1. Native | `design/html/*.html` + `design/scss/base` | Semantic HTML, no JS | Keyboard and screen reader work, axe passes, looks right |
| 2. Componentize | `design/elements/*` | Lit component rendering the same native markup | Screenshot matches the prototype; it only adds behaviour or API |
| 3. Compose | `design/patterns/*`, then `apps/*/src/features` | Components built from elements | Uses only elements and semantic tokens |

### Layers

| Layer | Tag prefix | May use | Never |
| --- | --- | --- | --- |
| `tokens` | none (CSS variables) | nothing | components, behaviour |
| `scss` | none | `tokens` | output selectors for components |
| `foundations` | none | `tokens`, `scss` | `customElements.define` |
| `elements` | `paas-` | the layers above, `icons`, `events` | other elements' internals, product logic |
| `patterns` | `paas-` | `elements` and below | data fetching, product logic |
| `apps/*/features` | `console-` | `patterns`, `elements`, `sdk` | token primitives, raw hex/px |

### Tokens

- `tokens/src/primitives/*.json` hold raw values (palette, space scale, type scale, radius, motion). Components never use them directly.
- `tokens/src/semantic/*.json` name the roles (`surface`, `text`, `border`, `accent`, `danger`, `inset-md`, `stack-lg`). Components use only these.
- `tokens/src/themes/` override semantic tokens for `light`, `dark` and `high-contrast`.
- `tokens/build.ts` emits `_tokens.scss` (maps + a `token()` function), `tokens.css` (`:root` custom properties), `themes/*.css` (`[data-theme]` overrides) and typed `tokens.ts`. A contrast test checks every text/surface pair against WCAG AA.

### SCSS

- **Sass computes at build time; CSS custom properties carry the theme at runtime.** `token(color, accent)` compiles to `var(--color-accent)`, which passes through shadow DOM and changes with `data-theme`.
- Colour maths only on primitives, never on themed values.
- One stylesheet per component: `button.scss` next to `button.ts`, compiled by `design/build/scss-plugin.ts` into a module the component imports as `static styles`.
- `scss/base` styles native elements (headings, forms, tables) for light DOM; `scss/layout` holds the only layout helpers (stack, cluster, sidebar, grid).
- Selectors are semantic: element names and states (`button`, `[aria-pressed="true"]`, `:disabled`, `[open]`). Classes only when no element or state describes the thing. No utility classes.

### Componentize rules

- **Render the native element, don't fake one.** `<paas-button>` contains a real `<button>`; never `<div role="button">`.
- **Enhance, don't replace,** when the native element already works: `<details>`, `<dialog>`, `<table>` stay native and Lit adds behaviour around them.
- **Page structure stays in light DOM.** Landmarks and headings are never hidden in shadow roots.
- **Styling hooks are public API:** `::part()` plus a few component variables (`--paas-button-radius`). Apps never reach into shadow DOM.
- **Form controls use `ElementInternals`** so they take part in native `<form>` submission and validation.
- **Definition and registration are separate.** Modules export classes; one `register.ts` per workspace calls `customElements.define`.
- **Every component folder follows the naming convention** (Composition and file naming): `paas.<thing>.base.ts` + `.scss`, variants, `paas.<thing>.zod.ts`, `*.e2e.ts`, `index.ts`, `fixtures/`, and a `README.md` that links the prototype in `design/html/` and lists props, slots, events, parts and the tokens used.
- **The catalog shows each prototype next to its component,** in every theme, with screenshot and axe tests in CI.

## Events and mediators

Components dispatch typed DOM events that bubble up; mediator elements higher in the tree catch them, perform the side effects, and pass state back down as properties or context.

| Role | Listens to | Emits | Side effects |
| --- | --- | --- | --- |
| Element (`paas-button`) | its own DOM | `paas-*` UI events | never |
| Pattern (`paas-data-table`) | children's UI events | higher-level UI events (`paas-sort`) | never |
| Feature (`console-app-list`) | patterns' UI events | domain events (`app-deploy-requested`) | never |
| Mediator (`apps-mediator`) | domain events from its subtree | results down via properties / context | **only here** |

### Event rules

- **Typed event classes, not ad-hoc `CustomEvent`.** Each is registered in `HTMLElementEventMap`, so listeners are type-checked.
- **`bubbles: true, composed: true` by default** (set in the `PaasEvent` base) so events cross shadow roots. `composed: false` only on purpose.
- **Naming:** UI events are `paas-<verb>`. Domain events are `<noun>-<verb>-requested` (please do this; the mediator decides) or `<noun>-<past tense>` (this happened).
- **Payloads are typed readonly fields** on the event, not `detail`, and never mutable shared objects.
- **A mediator stops what it handled** (`stopPropagation()`), so no event is handled twice. Unhandled events reach `shell-mediator`, the app-wide fallback.
- **Vetoes use `cancelable`.** A mediator calls `preventDefault()` on `paas-dismiss` to keep a dialog with unsaved changes open; the dialog checks `defaultPrevented`.

```ts
// design/events/src/paas.event.base.ts
export class PaasEvent extends Event {
  constructor(type: string, init: EventInit = {}) {
    super(type, { bubbles: true, composed: true, ...init });
  }
}

// apps/console/src/events/console.app.events.ts
export class AppDeployRequested extends PaasEvent {
  static readonly type = 'app-deploy-requested';
  constructor(readonly appId: AppId) { super(AppDeployRequested.type); }
}
declare global {
  interface HTMLElementEventMap { 'app-deploy-requested': AppDeployRequested }
}
```

### Mediators are elements

```ts
// apps/console/src/mediators/console.apps.mediator.ts
export class AppsMediator extends LitElement {
  @provide({ context: appsContext })
  @state()
  apps: AppsState = initialAppsState;

  constructor() {
    super();
    this.addEventListener('app-deploy-requested', this.#onDeploy);
  }

  #onDeploy = async (e: AppDeployRequested) => {
    e.stopPropagation();
    this.apps = { ...this.apps, deploying: e.appId };
    await sdk.deploys.create(e.appId);
    this.dispatchEvent(new ToastRequested(`Deploying ${e.appId}`));
  };

  render() { return html`<slot></slot>`; }
}
```

```html
<apps-mediator>
  <console-app-list></console-app-list>
  <console-app-detail></console-app-detail>
</apps-mediator>
```

- **No visuals:** a mediator renders only a `<slot>`, so page markup stays semantic and in light DOM.
- **Children subscribe with `@consume`** or receive properties; they never import a mediator.
- **Testing:** mount the mediator with a fake SDK, dispatch an event on a child, assert the SDK call and the new state.
- **Two homes:** `design/mediators` holds generic ones (form, selection, shortcuts); `apps/*/src/mediators` holds domain ones.

## Schemas: Zod first

Zod 4 schemas are the only definition of any data shape; types come from `z.input` / `z.output`, and data crosses every boundary through a codec: parse in, a pure middle layer, parse out.

```
packages/contracts/src/
├── primitives/
│   ├── paas.id.zod.ts                 # branded ids
│   ├── paas.time.codec.zod.ts         # iso string <-> Date
│   └── paas.page.zod.ts               # pagination
├── app/                               # one folder per domain noun, same files every time
│   ├── paas.app.wire.zod.ts           # AppWire schema + type: JSON as it travels
│   ├── paas.app.domain.zod.ts         # App schema + type: what code works with
│   ├── paas.app.codec.zod.ts          # AppCodec = z.codec(AppWire, App, ...)
│   ├── paas.app.command.zod.ts        # CreateApp, UpdateApp
│   ├── paas.app.map.ts                # pure domain -> domain (the middle layer)
│   ├── paas.app.codec.e2e.ts          # @unit round-trip specs
│   ├── index.ts
│   └── fixtures/app.wire.data.json
├── deploy/  env/                      # same files
├── problem/paas.problem.wire.zod.ts   # problem+json
├── config/paas.config.zod.ts          # machine config
└── paas.openapi.ts                    # z.toJSONSchema() inside an OpenAPI shell
```

| Layer | File | Does | Never |
| --- | --- | --- | --- |
| Parse in | `paas.<noun>.codec.zod.ts` decode | Untrusted wire data -> validated domain object | Business logic |
| Middle | `paas.<noun>.map.ts` | Pure domain -> domain: derive, merge, sort, summarise | Wire shapes, I/O, Zod calls |
| Parse out | `paas.<noun>.codec.zod.ts` encode | Domain -> wire shape, validated on the way out | Business logic |

```ts
// paas.app.wire.zod.ts
export const AppWire = z.object({
  id: z.string(),
  name: z.string().min(1, { error: 'Name is required' }).max(63),
  created_at: z.iso.datetime(),
  env_count: z.int().nonnegative(),
});

// paas.app.domain.zod.ts
export const AppId = z.string().brand<'AppId'>();
export const App = z.object({
  id: AppId,
  name: z.string(),
  createdAt: z.date(),
  envCount: z.int(),
});

// paas.app.codec.zod.ts: both directions validated by Zod
export const AppCodec = z.codec(AppWire, App, {
  decode: (w) => ({ id: w.id, name: w.name, createdAt: new Date(w.created_at), envCount: w.env_count }),
  encode: (a) => ({ id: a.id, name: a.name, created_at: a.createdAt.toISOString(), env_count: a.envCount }),
});

// types sit next to their schemas, derived, never the reverse
export type AppWire = z.input<typeof AppCodec>;
export type App = z.output<typeof AppCodec>;

// paas.app.map.ts: the middle layer
export const byNewest = (a: App, b: App) => b.createdAt.getTime() - a.createdAt.getTime();
```

Untrusted input (`unknown` JSON) goes through `AppCodec.safeParse(json)`, which runs decode and accepts any input; `.decode()` is for values already typed as the wire shape (DB rows, internal queues). Going out: `AppCodec.encode(app)`. Codecs need Zod 4.1 or later.

| Boundary | In | Out |
| --- | --- | --- |
| API request | `CreateApp.safeParse(body)` |  |
| API response |  | `AppCodec.encode(app)` |
| SDK | `AppCodec.parse(json)` | `CreateApp.parse(input)` before send |
| DB | `AppRowCodec.decode(row)` | `AppRowCodec.encode(app)` |
| Events / queues | decode on consume | encode on publish |
| Config | `Config.parse(raw)` once at boot |  |
| UI forms | form-mediator parses field values |  |

Rules:

- **No hand-written `interface` or `type` for data shapes.** `check-boundaries.ts` flags `interface` declarations in `contracts`.
- **Wire and domain types are different types on purpose**; between boundaries code sees only domain types.
- **Untrusted input uses `safeParse`.** Failures become a `validation` error with `z.treeifyError()` as field details.
- **The middle layer is pure:** domain in, domain out. Test it with fixtures built by `App.parse(...)`.
- **Branded ids** (`AppId`, `DeployId`) are created only by decoding, so ids can't be mixed up.
- **OpenAPI is generated** from the wire schemas, committed, and diffed in CI.
- **Error messages live in schemas** (`{ error: '...' }`), so server and UI say the same thing.

## Errors

Eight semantic error kinds, defined once in `@paas/errors`, travel unchanged from a service through HTTP (as problem+json, [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)) and the SDK into the UI.

| Kind | HTTP | Meaning | Default UI handling |
| --- | --- | --- | --- |
| `validation` | 422 | Input is wrong; `details` lists fields | Inline per field via form-mediator |
| `unauthenticated` | 401 | Not signed in, or session expired | Redirect to sign-in |
| `forbidden` | 403 | Signed in but not allowed | Inline "no access" state |
| `not-found` | 404 | Resource doesn't exist | Empty or error state in the region |
| `conflict` | 409 | Stale state, already exists | "Reload or overwrite" choice |
| `rate-limited` | 429 | Caller over its limit; `retryAfter` | Toast with countdown, automatic retry |
| `unavailable` | 503 | Overloaded or dependency down; `retryAfter` | Banner, retry with backoff |
| `internal` | 500 | A bug | Generic message + request id |

```
packages/errors/src/
├── paas.error.base.ts       # AppError: kind, status, message, details, cause
├── paas.error.kinds.ts      # NotFound, Validation, Conflict ... one class per kind
├── paas.error.problem.ts    # AppError <-> problem+json (contracts wire schema)
├── paas.error.guards.ts     # isAppError(e), isKind(e, 'not-found')
├── paas.error.problem.e2e.ts
└── index.ts
```

### Flow

1. **Services throw semantic errors** (`throw new NotFound('app', appId)`) and never build responses.
2. **One handler** (`services/api/src/middleware/error-handler.ts`) turns `AppError` into problem+json with the request id. Anything else becomes `internal`: full stack in the log, no internals in the response.
3. **The SDK parses problem+json back into the same classes,** so callers catch `NotFound`, not `status === 404`.
4. **In the UI, errors are events.** A mediator handles its own kinds first (form-mediator maps `validation` to fields); anything else is dispatched as `error-occurred` and bubbles to `error-mediator`, which applies the default handling above.
5. **Async handlers are wrapped.** A rejected promise in an event listener doesn't propagate through the DOM, so mediator handlers go through `handled(this, fn)`, which catches and dispatches `error-occurred` from the mediator.
6. **Wrap, don't swallow.** Re-throws pass the original as `cause`; logs show the chain, users see the semantic message.
7. **Regions render the `paas-error-state` pattern,** never ad-hoc error markup.

## Debug levels

One namespaced, leveled logger (`@paas/debug`) is used everywhere, switched with one syntax on the server, in the CLI and in the browser, and close to free when off.

Levels: `off < error < warn < info < debug < trace`. The switch:

```
PAAS_DEBUG="api:*=debug,builder=trace,*=warn"
```

| Where | Source | Persistence |
| --- | --- | --- |
| Services, CLI | `PAAS_DEBUG` environment variable | Process lifetime |
| Console | `?debug=...` URL parameter | Saved to `localStorage` |
| Running service | `PUT /admin/debug` (admin scope) | Until restart |
| Running console | `<console-debug-panel>` (role-gated, keyboard shortcut) | `localStorage` |
| One request | `x-debug: api:*=trace` header (admin scope only) | That request |

```ts
const log = debug('api:deploys');
log.info('deploy queued', { appId });
log.debug(() => ({ plan: computePlan(app) })); // closure only runs when debug is on
```

- **Namespaces mirror the repo:** `api:deploys`, `builder:cache`, `console:mediator:apps`, `ui:dialog`, `http:shed`, `resilience:breaker`. A log line tells you which folder to open.
- **Structured output:** services write NDJSON (`ts`, `level`, `ns`, `msg`, `requestId`, fields) to stdout; the browser groups `console.*` output by namespace.
- **Redaction always runs,** at every level: tokens, keys and emails are masked before output.
- **Each `AppError` is logged once,** by the handler that converts it: `error` for `internal`, `warn` for the rest, always with the request id the user sees.
- **Health stays outside the process:** each service's `health` sidecar probes it over the network; a service never reports itself healthy.

## HTTP citizenship

Servers answer with the precise status and headers for each situation ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110)); clients time out, retry only what's safe, back off honestly, and fail over or degrade visibly. `@paas/http` is the server half, `@paas/resilience` the client half.

| Situation | Code | Headers / body |
| --- | --- | --- |
| Read ok | 200 | `ETag`, `Cache-Control` |
| Created | 201 | `Location`, body = the resource |
| Accepted, work continues (build, deploy) | 202 | `Location` of a status resource |
| Success, nothing to return | 204 |  |
| Not modified | 304 | from `If-None-Match` |
| Malformed (bad JSON, bad syntax) | 400 | problem+json |
| Not authenticated | 401 | `WWW-Authenticate` |
| Not allowed | 403 | problem+json |
| No such resource | 404 | problem+json |
| Path exists, method doesn't | 405 | `Allow` |
| Can't produce the requested format | 406 |  |
| Client too slow sending | 408 |  |
| State conflict | 409 | problem+json |
| Permanently removed | 410 |  |
| Stale write | 412 | from `If-Match` |
| Body too large | 413 |  |
| Wrong `Content-Type` | 415 | `Accept-Patch` where it applies |
| Well-formed but invalid (Zod failure) | 422 | problem+json with field errors |
| Write without `If-Match` on a protected resource | 428 |  |
| Caller over its rate limit | 429 | `Retry-After` |
| Headers too large | 431 |  |
| Bug | 500 | problem+json, request id only |
| Bad upstream answer | 502 |  |
| Overloaded or dependency down | 503 | `Retry-After` |
| Upstream timed out | 504 |  |

`429` means "you are sending too much"; `503` means "we are struggling". Clients treat them differently.

### Server: @paas/http

- **router.ts:** `URLPattern` route table (Bun 1.3.4 or later); returns 404 vs 405 + `Allow` correctly; answers `HEAD` and `OPTIONS` automatically.
- **conditional.ts:** every resource has an `ETag`; reads honour `If-None-Match`; writes to shared resources require `If-Match` (412 on mismatch, 428 when missing). No lost updates, no locks.
- **idempotency.ts:** `POST` accepts `Idempotency-Key`; key + request hash + response stored 24 h. Same key and body returns the stored response; same key with a different body is a 422.
- **Long work returns 202** plus a status resource; nothing holds a request open for minutes.
- **shed.ts:** per-service concurrency limit with a short bounded queue; when it's full, reject at once with 503 + `Retry-After`. Per-caller token buckets return 429. Health and admin routes have reserved capacity.
- **deadline.ts:** clients send `x-request-deadline`; handlers pass the remaining budget downstream and stop work when it expires.
- **limits.ts:** body size (`maxRequestBodySize` in `Bun.serve`), header size and read timeouts.
- **cache.ts:** presets per route kind (`immutable` hashed assets, `no-store` secrets, `private, max-age=0, must-revalidate` user data) with a correct `Vary`.
- **shutdown.ts:** on `SIGTERM` fail readiness, stop accepting, drain in-flight requests within a grace period, exit.

### Client: @paas/resilience

- **Every call has a timeout:** `min(per-call limit, remaining deadline)` via `AbortSignal`.
- **Retry only safe requests:** `GET`, `HEAD`, `PUT`, `DELETE`, and `POST` with an idempotency key. Only on network errors, 408, 429, 502, 503, 504; never on other 4xx.
- **Full-jitter exponential backoff,** capped. `Retry-After` wins but is clamped to a configured maximum, so a quota wall can't stall the client for days.
- **Retry budget:** retries capped at about 10% of requests per upstream, so a struggling upstream isn't hit by a retry storm.
- **Circuit breaker per upstream:** closed, open after N failures or a high error rate, half-open with one probe. Open means fail fast to failover or fallback.
- **Failover:** ordered endpoint list from config; skip endpoints whose breaker is open; return to the primary once it recovers.
- **Fallback order:** fresh cache, then stale cache (marked stale in response and UI), then a degraded answer, then an `unavailable` error. Every fallback step logs at `warn`.
- **Client-side concurrency limits** stop one busy page or CLI loop from flooding the API.

Limits, timeouts, endpoint lists and breaker thresholds are Zod-validated machine config, never constants in code.

## Testing: Playwright only

Every test in the repo, browser or not, is a `@playwright/test` spec named `*.e2e.ts`, run through one composed config with projects, dependencies and tags. Load tests rerun the same specs; there is no second test format.

### One shared config, composed per package

`@paas/testing` exports the config builder and fixtures; each package's `playwright.config.ts` is a few lines.

```ts
// packages/testing/src/paas.testing.config.ts
export const definePaasConfig = (opts: { webServer?: WebServer[] } = {}) =>
  defineConfig({
    testMatch: '**/*.e2e.ts',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
    use: { trace: 'on-first-retry', screenshot: 'only-on-failure' },
    webServer: opts.webServer,
    projects: [
      { name: 'setup', testMatch: '**/*.setup.e2e.ts' },
      { name: 'smoke', grep: /@smoke/, dependencies: ['setup'] },
      { name: 'unit', grep: /@unit/, dependencies: ['smoke'] },
      { name: 'api', grep: /@api/, dependencies: ['smoke'] },
      { name: 'chromium', grep: /@ui/, use: devices['Desktop Chrome'], dependencies: ['smoke'] },
      { name: 'firefox', grep: /@ui/, use: devices['Desktop Firefox'], dependencies: ['smoke'] },
      { name: 'webkit', grep: /@ui/, use: devices['Desktop Safari'], dependencies: ['smoke'] },
      { name: 'visual', grep: /@visual/, use: devices['Desktop Chrome'], dependencies: ['chromium'] },
      { name: 'a11y', grep: /@a11y/, use: devices['Desktop Chrome'], dependencies: ['chromium'] },
    ],
  });

// services/api/playwright.config.ts
export default definePaasConfig({
  webServer: [{ command: 'bun run bin/paas-api.ts', url: 'http://127.0.0.1:4310/healthz', reuseExistingServer: !process.env.CI }],
});
```

| Project | Runs | Browser | Depends on |
| --- | --- | --- | --- |
| `setup` | Seeds data, mints test tokens, saves auth state | no | none |
| `smoke` | `@smoke`: a few fast checks that the thing starts at all | no | `setup` |
| `unit` | `@unit`: pure modules, codecs, `map.ts`, mediators with fakes | no | `smoke` |
| `api` | `@api`: HTTP contract via the `request` fixture | no | `smoke` |
| `chromium` / `firefox` / `webkit` | `@ui`: components and pages | yes | `smoke` |
| `visual` | `@visual`: prototype vs component screenshots, per theme | Chromium | `chromium` |
| `a11y` | `@a11y`: axe on every catalog page | Chromium | `chromium` |

If smoke fails, nothing downstream runs.

### Controlling runs

| Goal | Command |
| --- | --- |
| Fast local check | `npx playwright test --project=smoke` |
| One layer | `npx playwright test --project=unit` |
| By tag | `npx playwright test --grep @api --grep-invert @slow` |
| One file or test | `npx playwright test paas.table.sortable.e2e.ts -g "sorts by name"` |
| Only what changed | `npx playwright test --only-changed=origin/main` |
| CI shard | `npx playwright test --shard=2/4` |
| Debug | `npx playwright test --debug` or `--ui` |

### Spec rules

- **Never raw setup in a spec.** Data, servers, auth and mounted fragments come from fixtures (`test.extend` in `@paas/testing`), fed by `fixtures/*.data.json` and `*.fragment.html` and validated against the `.zod.ts` schemas.
- **Every test carries tags** for its project (`@smoke`, `@unit`, `@api`, `@ui`, `@visual`, `@a11y`, plus `@slow` where it applies), via `test('...', { tag: ['@ui'] }, ...)`.
- **Shared steps live in flows.** When two or more specs repeat a sequence, it moves to a `*.flow.ts` function; specs call it and assert.
- **Stateless units need no browser:** give input, assert output, under the `unit` project.
- **Bun APIs in tests:** Playwright workers run on Node by default. Packages whose fixtures need `Bun.*` run the suite as `bun --bun playwright test`; prefer reaching Bun-only code through its HTTP or CLI surface instead.

### Load tests: the same specs, run as load

Load runs the existing specs tagged `@load` through a `load` project: Playwright repeats them across many workers and shards, and a small reporter turns the results into latency and status-code figures. There is no second test format and no duplicated steps.

```ts
// added to the projects in paas.testing.config.ts
{
  name: 'load',
  grep: /@load/,
  repeatEach: Number(process.env.PAAS_LOAD_REPEAT ?? 200),
  retries: 0,
  dependencies: ['smoke'],
}
// paas.load.reporter.ts: p50/p95/p99 per test, counts of 2xx / 429 / 503 / other
```

| Goal | Command |
| --- | --- |
| Local load burst | `npx playwright test --project=load --workers=32` |
| Bigger load across machines | `npx playwright test --project=load --workers=64 --shard=1/8` on 8 runners |
| API-only load (no browser, cheapest) | Tag `@api @load` specs that use the `request` fixture |

- **What it proves:** under overload the API answers 503 or 429 with `Retry-After` quickly rather than slowing down for everyone, and the UI shows the retry state instead of failing.
- **What it can't do:** Playwright drives a fixed number of concurrent workers. It has no arrival-rate model like a dedicated load tool, and browser projects need about one CPU per worker. If traffic modelling at very high request rates is ever needed, it gets its own decision. Loadster says it runs `@playwright/test` specs as cloud load tests; that is a vendor claim, unverified here.

## Code review: agents first, humans by risk

Agents write, review and merge most changes; review is scaled to risk, and a change that needs a person is raised as a decision rather than left waiting in a queue. The model is the one described in [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/) (Anthropic, 15 Oct 2026): layered checks, risk-tiered approvals, fast rollback.

### Layers

1. **Verified before review.** The authoring agent runs the checks (qlty, Playwright smoke + changed specs, `check-*`) and shows the output; "done" without output doesn't count.
2. **Fresh-context review.** A second agent reviews the diff with no shared context. When the machine has fleet, this runs on the local LLM tier through buckle (`oracle review`, pinned to the local reason model by default; `--cloud` only for high-risk tiers). Without fleet, `/code-review` and `/security-review` run locally.
3. **Required CI.** Everything in Enforcement. Red blocks the merge.
4. **Bug review on the PR.** Several reviewers hunt in parallel; a separate verifier pass votes on each finding and keeps only those enough of them agree on. Style-only findings are dropped. Survivors are tagged Important, Nit or Pre-existing.
5. **Security review,** a separate pass. Any open finding from either review blocks the merge until it is fixed or closed with a reason.
6. **Risk-tiered approval** (below).
7. **Rebase-merge queue.** Checks rerun on the latest `main` with the change applied.
8. **After merge:** behind a flag, staged rollout, one-step revert.

### Risk tiers

A classifier reads the **change, not the author**, and sets the tier. A second check asks whether this specific change needs a person even when its tier says no.

| Tier | Examples | Human approvals | How it lands |
| --- | --- | --- | --- |
| Low | Docs, copy, tests, additive changes behind a flag, `design/` styles | 0 | The agent merges once CI and both reviews are clean |
| Medium | Ordinary product changes; caching, HTTP shedding/retry behaviour, `@paas/contracts` wire schemas | 1 | Raised as a decision; one approval |
| High | `@paas/auth`, secrets/key minting, billing, `infra/`, `.github/workflows/`, release tooling, `.npmrc`, `.prefer.example`, `check-*` tools | 2 | Raised as a decision; two approvals |

**Decisions, not queues.** A Medium or High change is raised as a decision for its owners. With fleet: `coord emit NEED_DECISION` with the PR, tier, findings summary, test evidence and how to revert. The agent then moves on to other work instead of waiting on the PR.

Approval rules:

- **An agent's approval never fills a human slot.** Automated review can clear Low; it can't stand in for a required person.
- **The person who directed the agent counts as one reviewer** and owns the outcome.
- **Approvals bind to one commit.** New commits the system can't vouch for (an agent push, a hand-resolved rebase) need approval again.
- **Only trusted authors get the lighter paths;** anyone else needs a second person.
- **Always-human paths** live in `CODEOWNERS` + branch protection, not in the classifier's judgement.

### Keeping review useful

- **Round cap of 3.** After three review-and-fix rounds the reviewer stops and asks the author to rethink the approach.
- **Diff-only re-review** after the first pass; never repeat a finding already posted.
- **Flag the class of bug,** so every instance gets fixed, not one line.
- **`REVIEW.md` per area,** short: what failure looks like there, paths to skip, a cap on nits, file:line evidence required, a summary that starts with a count.
- **Repeated findings get fixed at the source:** a lint rule, a `check-*` rule, or a line in `AGENTS.md` / `REVIEW.md`.
- **Incidents become evals.** Every revert or incident adds a case; reviewer prompt, model or tool changes are rescored against the whole set.
- **Measure human time** (approvals per PR, time waiting on a person), with revert and incident rates as the guardrail: if they rise, tighten the tiers.
- **PR template:** Testing (the commands and their output), Risk tier, How to revert.

## Enforcement

Every rule above has a check that fails CI; a rule without a check is a wish.

| Check | Fails when | Runs in |
| --- | --- | --- |
| `npm ci` | Lockfile out of sync with any `package.json` | CI |
| `tools/src/check-versions.ts` | Any version or dependency spec isn't exact `MAJOR.MINOR.PATCH`; workspaces disagree on the repo version; root `package.json` has dependencies | pre-push, CI |
| `tools/src/check-deps.ts` | Undeclared import (phantom dep), unused declared dep, dep not on the allowlist, relative import leaving its workspace | pre-push, CI |
| `tools/src/check-boundaries.ts` | Layer rule broken (app imports a service, element imports a pattern, contracts imports anything but `zod`); `interface` in contracts; per-workspace `tsc --noEmit` fails | pre-push, CI |
| `tools/src/check-ui-laws.ts` | `innerHTML`, `document.write`, raw hex/px in component styles, primitive tokens in components, CDN imports, `div`/`span` with an interactive `role` | on save, CI |
| `qlty check` / `qlty fmt` | Lint or format differs from qlty defaults; qlty smells finds duplication or complexity over its default thresholds | on save, pre-push, CI |
| `bun test` | Any Playwright project fails (smoke first; downstream projects only run when smoke passes) | pre-push, CI |
| Catalog e2e (`@playwright/test`) | Screenshot drift between prototype and component; axe violations; token contrast below WCAG AA | CI |
| `tools/src/gen-openapi.ts --check` | Committed OpenAPI differs from the Zod wire schemas | CI |
| Branch protection | Merge commit on `main`, force-push to `main` | forge |
| `tests/paas.law-guards.e2e.ts` | New `.sh` file`; .ts file over 1500 lines (warning from 1200: decompose first); a test file not named *.e2e.ts; a source file not named <namespace>.<thing>.<role>.t`s | CI |

Also in CI: `tools/src/check-pack.ts` (every package packs, installs outside the repo, imports and runs its `bin --help`), and `check-versions.ts` fails any directory under the six package groups that has no `package.json`.

Hooks live in `.githooks/` (committed), wired by `core.hooksPath`. They are TypeScript entry points run by Bun; the hook files themselves are one-line launchers.

## Review log

Ten corrections were made to the earlier drafts while combining them into this standard.

| Area | Earlier draft said | Corrected to | Why |
| --- | --- | --- | --- |
| Installs | Bun workspaces, `bun.lock` | npm workspaces, `install-strategy=linked`, `npm ci` | House rule: npm installs; linked strategy gives isolated per-package `node_modules` |
| Installs | Isolation alone prevents phantom deps | Plus: root has no deps, name-only imports, `check-deps.ts` | Node resolution still walks up to the root; isolation doesn't stop that |
| Worktrees | `.worktrees/` inside the repo | `../paas.worktrees/` beside it | A worktree inside the checkout resolves the main checkout's `node_modules` |
| Versions | Not specified | Exact pins everywhere, plain `MAJOR.MINOR.PATCH`, one repo version | House rule |
| Lit | Vendored copy of Lit | Exact-pinned npm `lit`, bundled, never CDN | One install path; the lockfile already makes it offline-reproducible |
| Lit decorators | `@provide` on a plain field | `experimentalDecorators` + `useDefineForClassFields: false` in UI tsconfigs | Plain class fields shadow Lit's reactive accessors under define semantics |
| Zod | `AppCodec.decode(json)` for untrusted JSON; `AppId.parse` inside decode | `safeParse` for `unknown` input, `.decode()` for typed input; no parse inside decode | `.decode()` expects typed input; the output schema already brands the id |
| Zod | `CreateApp.encode(input)` in the SDK | `CreateApp.parse(input)` | It has no transform; encode adds nothing |
| Errors | Async mediator handlers unguarded | `handled(this, fn)` wrapper dispatches `error-occurred` | Rejected promises in DOM listeners are lost silently |
| Dependencies | "Six runtime dependencies" | Seven, split runtime vs build/test, incl. `@types/bun` | `types: ["bun"]` needs `@types/bun`; sass/typescript aren't runtime |

Added after the first review:

- **Every directory under the six groups is an npm package** (package contract + `check-pack.ts`). `infra/` was plain folders and is now three packages; `tools/` is one package with bins, so the `tools/src/*` paths stay valid.
- **`.prefer` harness lock-down** added. Its upward walk conflicted with worktrees placed beside the repo, so the main checkout and its worktrees now share a tree root (`~/code/paas-tree/`) that holds the `.prefer`.

Added in the third round:

- **Composition and file naming:** `<namespace>.<thing>.<role>.ts`, a 1500-line hard cap with a stop-and-decompose point at 1200, repo-wide duplicate scans (`qlty smells`, `ast-grep`), stateless leaves. Every file path in the doc's examples was renamed to match.
- **Playwright is the only test framework.** `bun test` is removed everywhere; every package has a `playwright.config.ts` built from `@paas/testing`, with setup, smoke, unit, api, browser, visual and a11y projects. Smoke is a dependency of every other project.
- **Artillery dropped.** Its Playwright engine runs plain functions, not `@playwright/test` specs, which would have meant writing tests twice. Load now reruns the same `@load`-tagged specs through a `load` project (`repeatEach`, workers, shards). Trade-off: no arrival-rate model.
- **Playwright workers run on Node.** Specs that need `Bun.*` run with `bun --bun playwright test`, as fleet does.
- **Code review section:** layered agent review following [the Claude Code team's process](https://claude.dev/blog/solving-code-review-at-anthropic/), fleet/buckle local-LLM review via `oracle review`, risk tiers set by the change, Medium/High raised as `NEED_DECISION` decisions, a round cap of 3.

**Open questions**

- npm's linked strategy only recently left experimental, and workspace bugs are still being filed. Pin a recent npm version, and keep no workspace nested inside another workspace's folder ([npm/cli#10082](https://github.com/npm/cli/issues/10082)).
- Version numbers in examples (`zod 4.1.12`, `npm@11.6.2`) are placeholders; pin current releases when the repo is set up.

## Sources

- [Zod API: codecs, `z.input` / `z.output`](https://zod.dev/api)
- [Introducing Zod Codecs (Colin McDonnell)](https://colinhacks.com/essays/introducing-zod-codecs)
- [npm: graduate linked install strategy to stable](https://github.com/npm/cli/commit/abd8c6b0ce01f2c2c964b1b14e53b37db90be2f5)
- [npm/cli#9072: linked strategy hoisting fix](https://github.com/npm/cli/issues/9072)
- [Bun v1.3.4: URLPattern support](https://bun.com/blog/bun-v1.3.4)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
