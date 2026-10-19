# FLEET.md — packages/decant

Fleet integration notes for the vendored dosu-ai/decant engine. This file is
fleet-authored; everything else at the top level is upstream-owned bytes.

## What this is

- Vendored source snapshot of [dosu-ai/decant](https://github.com/dosu-ai/decant)
  at tag `v0.11.0` (Apache-2.0; `LICENSE` + `NOTICE` kept verbatim). Pin:
  dosu-ai/decant `v0.11.0`, vendored 2026-10-19 (W950).
- The CLI surface is upstream-stable: `bun packages/decant/src/cli.ts` —
  `sync --claude-dir/--codex-dir/--gemini-dir/--opencode-dir/--path`, `serve`,
  `ls --json`, etc. all behave as upstream v0.11.0. W943/W944 lanes keep
  working against the same verbs/flags/JSON shapes.
- Config contract unchanged: `DECANT_*` env + the `--*-dir` flags. The
  `decant key` + `decant.yaml` machine-conf design belongs to W944; nothing
  here changes it.

## Curated exclusions from the snapshot

Upstream automation/distribution surfaces are NOT vendored (fleet law: shell
scripts are banned; the fleet runs the engine via `bun src/cli.ts`):

- `install.sh`, `justfile`, `.pre-commit-config.yaml`, `.github/`, `npm/`,
  `packaging/`, `Dockerfile`, `.dockerignore`, `.claude/`, `AGENTS.md`,
  `CLAUDE.md`.
- Upstream tests dropped with their surfaces (10 files): `npm-launcher`,
  `install-sh`, `release-validate`, `release-publish`, `distribution`,
  `release-artifacts`, `ui-dosu-copy` (each reads an excluded surface at
  module load). The rest of the upstream suite (119 files, 1444 tests) ships
  and passes in the snapshot — it is THE parity net for the engine.

## The adapter layer (fleet-owned: `fleet/`)

Our changes live here, not in upstream files. qlty excludes the snapshot dirs
but not `packages/decant/fleet/`, so this layer stays linted.

- `fleet/registry.ts` — the session-source registry (the W950 seam). Entries
  are keyed by W918 skills-CLI target id (`AgentType`); each entry resolves
  session dirs + names the decant `Tool` (transcript-format adapter) that
  parses it. The stock four (`claude-code`, `codex`, `gemini-cli`, `opencode`)
  preserve upstream dir resolution (decant env/flag overrides win first).
- `fleet/after-sync.ts` — the self-extending miss path: after every CLI
  `sync`, detected catalog targets with no registered adapter are surfaced
  and (unless `DECANT_ADAPTER_MINT=0`) minted as `decant adapter: <cli-id>`
  work items — title + sample PATHS only (never contents; scrub discipline),
  one pending item per cli-id, `DECANT_WORK_BIN` overrides the work CLI
  (default: `work` on PATH).

## The seam (minimal in-file edits, rebase recipe)

Exactly two upstream files carry W950 edits; both are one-line delegation
points. On an upstream re-sync, re-apply them by hand:

1. `src/ingest.ts` — `discover()` delegates to the registry when no
   `--path` override is present:
   `return discoverFromSessionSources(config, discoverSourcePaths);`
2. `src/cli/commands/sync.ts` — the sync action calls
   `afterSync(...)` (fleet layer) after the ingest report lands.

Plus a fleet section added to `README.md` (the unencrypted-archive caveat).

## Caveats (owner law — keep these visible)

- **Unencrypted archive**: decant copies transcripts + tool output into
  `~/.decant/decant.db` (0600, local-only). Never commit from it, never
  quote credential-shaped strings it surfaces. W944's policy layer owns the
  machine-boundary rules (metrics-only by default, content deny-by-default).
- **One parser implementation**: never parse the archive db directly — the
  engine's own sync/export is the only implementation (W944 design, kept).

## Upstream re-sync recipe

1. Clone the new upstream tag to /tmp (shallow).
2. Copy the snapshot dirs/files (same scope as the W950 vendor commit).
3. Re-apply the two seam edits + the README fleet section.
4. Re-drop the curated test files (list above).
5. `bun install --frozen-lockfile` in this package, run `bun test` (expect
   the upstream suite green), then `bun test fleet/` for ours.
