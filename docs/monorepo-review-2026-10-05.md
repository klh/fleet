# Fleet monorepo review

Reviewed 5 October 2026; initial snapshot `57c8cf6`, refreshed through `1e50396` after concurrent migration changes. Scope: package boundaries, migration,
installation, deployment, quality automation, architecture and documentation.
This is an integration review, not a full security audit of every package.
The pre-existing `monorepo-audit-2026-10-05.md` supplied context; the findings
below were checked against this checkout.

## Assessment

The package split expresses a coherent system: developer configuration, agent
coordination, governed model access, model operations, service access and failure
evaluation. Consolidation makes shared implementations possible: suspenders now
uses BLAM's prompt engine, and focused tests verify that source-level boundary.

Source has moved before consumers have fully adapted. The priority is making
the source checkout, installed harness and deployed hub use the same dependency
graph and directory layout. A clearer README cannot substitute for those changes.

## Findings

### P1: A successful clean install leaves board modules unloadable

Evidence: `packages/suspenders/install.sh:59-65` copies hook directories and its
manifest/lockfile without BLAM. `hooks/board/prompt-transform.ts:7` and `orch.ts:18`
import `../../../blam/src/condense/tiers.ts`.

Reproduced with a temporary HOME, prefix and shim directory, running the actual
installer with `--no-llm`. Installation exited 0; importing the installed
`board/prompt-transform.ts` exited 1 with `Cannot find module
'../../../blam/src/condense/tiers.ts'`. That relative path resolves to
`<temporary HOME>/.claude/blam/src/condense/tiers.ts`, not a sibling under
`.claude/hooks/`. The source import passes.

Distribute BLAM through a declared dependency or deliberate bundled artifact.
If retaining relative paths temporarily, verify exact installed resolution.
Add an installer regression that loads installed board modules; file-existence
assertions alone cannot detect this failure.

### P1: Consolidated code has no root CI workflow

Tracked workflows are under `packages/suspenders/.github/workflows/` and
`packages/speedy/.github/workflows/`; no root `.github/workflows/` exists.
The suspenders workflow includes test, entrypoint parse and installation checks,
but remains in the old repository location.

Restore root workflows with explicit package working directories and dependency
setup, including cross-package and installed-artifact checks. Moving YAML alone
is insufficient: commands currently assume suspenders is the repository root.
This finding concerns the checkout; remote Actions run history was not queried.

### P1: Hub deployment still assumes independent legacy repositories

`packages/suspenders/deploy/hub-compose.yaml:37,107,205` defaults to the old
buckle, suspenders and belt origins. Mounts and commands expect package files at
each repository root (`:46-47`, `:116`, `:215`). `deploy/hubctl.ts:104-105,121-124`
still renders separate origins and refs.

Without overrides, deploys follow old sources. Pointing those origins at fleet
alone leaves commands using the wrong layout: `src/server.ts` now lives under
`packages/buckle/`. Convert volumes, commands, config paths and dependency
preparation together, then verify fresh boot and upgrade from old volumes.

The example config adds another onboarding problem: `stack.example.yaml:42-44`
uses host paths in `repos`, which hubctl renders as origin URLs for container
clone operations. Replace them with deployable origin examples during conversion.

### P2: Workspace and release wiring lag behind the declared monorepo

Root `package.json:6` declares `packages/*`, but local and speedy lack
manifests. There is no root lockfile. Buckle and suspenders retain package
lockfiles; package versions range from 0.1.0 to 1.0.0 while root is 2.0.0.
No tags are present in the local checkout.

Some directories are asset/script collections, so missing manifests alone need
not be defects. The issue is the absence of a reproducible cross-package install
contract. Finish dependency/export wiring, decide which directories are workspace
packages, and define stack-version relationships to package versions and deploy
refs. A manifest version alone does not establish a released v2.0.0.

### P2: The umbrella installer still acquires legacy repository sources

`packages/speedy/bin/install-fleet.ts:46-47` stores legacy suspenders and local
clone URLs; its plan describes buckle as an independent clone (`:140`). Package
READMEs retain pre-migration installation instructions.

A new user can acquire an old layout even when starting in fleet. Install from
a pinned fleet checkout/artifact with package-local sources. Verify an isolated
home without old repositories or harness files; preserve operator configuration
separately from executable refreshes.

### P2: Engineering laws overstate completed UI migration

`packages/suspenders/hooks/board-html/core.ts:34` assigns `innerHTML` in the shared
rendering helper; `tasks.ts:82` does likewise for project options. These are source
modules, not vendored Lit internals. Doctrine prohibits these assignments and
also describes replacement as staged work.

Present Lit as the standard with legacy rendering still being retired. Continue
the component migration with browser checks for selection, focus and draft
retention. These assignments alone do not prove XSS; no browser vulnerability
was reproduced in this review.

## Validation and limits

- Read root and package instructions, manifests, READMEs, licensing files,
  deployment templates, installer code and shared imports.
- BLAM condenser, suspenders prompt-transform and lane-auth suites:
  **120 passed, 0 failed, 1,164 assertions** across three files.
- Actual installer in an isolated temporary home with `--no-llm`: reproduced
  the installed BLAM import failure and removed temporary files afterwards.
- Inspected tracked workflow locations, manifests, lockfiles and local tags.

No production configuration was read or modified. No model download, real
harness rewiring, hub deployment or full-stack browser test was performed.
Passing source tests does not establish installed or deployed correctness.

## Recommended order

Repair the installed dependency boundary and restore root CI first. Complete
workspace and installer wiring together, then convert deployment and validate
fresh and upgrade paths. Reconcile package documentation and version semantics
against verified paths. Keep benchmark claims bounded by sample-size labels.

The work graph already contains migration and hardening items; this report is
review evidence, not a second task ledger.
