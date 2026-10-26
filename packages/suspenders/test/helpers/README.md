# test/helpers — the fleet testing kit (W1294.1)

One module for config + fixtures. A package's `test/playwright.config.ts`
imports `defineFleetConfig` and adds deltas only — projects, tags and the
smoke dependency chain are declared HERE once, so migration waves cannot
fork the config shape.

## Config builder

```ts
import { defineFleetConfig } from "@klh/suspenders/test/helpers/testing-kit.ts";

export default defineFleetConfig({
  // Discovery root — pass `import.meta.dir` (the config file's dir).
  // REQUIRED in practice: an unset/relative testDir discovers nothing
  // when the runner is invoked from the repo root with --config.
  testDir: import.meta.dir,
  // Optional deltas:
  testMatch: ["**/*.e2e.ts", "**/*.spec.ts"], // default "**/*.e2e.ts"
  extraProjects: [/* appended after the five standard projects */],
  timeout: 120_000,
});
```

Projects (fixed shape): `setup` (`*.setup.ts` slot) → `smoke` (`@smoke`,
depends on setup) → `unit` (`@unit`) · `api` (`@api`) · `chromium` (`@ui`,
headless). Tags ride `grep: /@tag/` REGEXES — under bun+playwright 1.63.0
an array grep (`grep: ["@smoke"]`) trips `TypeError: Attempted to assign
to readonly property` during config normalization. Never re-declare
projects in a package config; use `extraProjects` for additions.

`testIgnore` excludes `node_modules`, `vendor`, `test-results`. NEVER add
`**/.worktrees/**`: a lane worktree IS the checkout, the pattern matches
the tree's own paths and zeroes discovery.

## Run channel

```sh
bun --bun node_modules/.bin/playwright test \
  --config=test/playwright.config.ts --project=smoke
```

The worktree-local bin is required — `bun x playwright` resolves from the
bun global cache (version skew). Pin `@playwright/test` EXACT (`1.63.0`)
in every package devDeps; a floating range pulls a second copy and specs
fail with "test() called here" dual-instance errors.

## Fixtures (re-exported)

`cleanupDirs`, `gitInit`, `tmpDir` (fixture-kit) · `cliFixture`, `CliResult`
(cli-e2e-harness) · `boardFixture`, `unusedPort` (board-fixture) — import
all from `testing-kit.ts`, one module for config + fixtures.

`hermeticEnv(env)` spreads a caller env with `FORCE_COLOR: "0"` pinned last
so lane leaks can't tint spawned fixtures.
