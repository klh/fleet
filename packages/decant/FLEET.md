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
  `CLAUDE.md`, `scripts/` (upstream build/release/parity automation —
  removed 2026-10-19 after landing in the first cut; same policy: the
  fleet runs the engine via `bun src/cli.ts`, release surfaces stay
  upstream).
- Upstream tests dropped with their surfaces (7 files): `npm-launcher`,
  `install-sh`, `release-validate`, `release-publish`, `distribution`,
  `release-artifacts`, `ui-dosu-copy` (each reads an excluded surface at
  module load). The rest of the upstream suite (119 files, 1444 tests) ships
  and passes in the snapshot — it is THE parity net for the engine.

## The adapter layer (fleet-owned: `fleet/`)

Our changes live here, not in upstream files. The root qlty config excludes
ALL of `packages/decant/**` (decant ships its own biome.json — a second
biome root; root-level runs conflict), and `fleet/biome.json` re-enables the
same rules for the fleet layer only, so `fleet/` stays linted under decant's
rule set.

- `fleet/registry.ts` — the session-source registry (the W950 seam). Entries
  are keyed by W918 skills-CLI target id (`AgentType`); each entry resolves
  session dirs + names the decant `Tool` (transcript-format adapter) that
  parses it. The stock four (`claude-code`, `codex`, `gemini-cli`, `opencode`)
  read the parity-resolved config values upstream `discover()` itself uses,
  so dir parity holds by construction; `registerSessionSource()` extends the
  registry per landed adapter.
- `fleet/after-sync.ts` — the self-extending miss path: after every CLI
  `sync`, detected catalog targets with no registered adapter are surfaced
  and (unless `DECANT_ADAPTER_MINT=0`) minted as `decant adapter: <cli-id>`
  work items — title + sample PATHS only (never contents; scrub discipline),
  one pending item per cli-id, `DECANT_WORK_BIN` overrides the work CLI
  (default: `work` on PATH).
- `fleet/confidence.ts` — the ingest-time confidence stamp (owner addendum,
  2026-10-19): every ingested session gets `{value: 0.4, setter:
"mechanical:decant", verdict: "fresh"}` written by a fleet-owned AFTER
  INSERT trigger on the `session` table — same transaction as the rows it
  grades, append-only history in `confidence_stamp`. Unit = the session
  derivation; consumers resolve row confidence through the session join.
- `fleet/biome.json` — the nested biome config for the fleet layer (same
  rule set as the package config; needed because the package config's
  `files.includes` predates `fleet/`).

## The seam (minimal in-file edits, rebase recipe)

`src/ingest.ts` stays BYTE-PURE: at 1986 lines it is over the fleet 1500-line
cap, so the on-write gate forbids editing it — and the fleet design doesn't
need to. The registry drives discovery through upstream's own `--path`
pathway: with no user `--path`, the CLI seam injects the registry-resolved
source list into `config.sourcePaths`, and upstream `discover()` routes
through its own exported `discoverSourcePaths()` collector (classification
identical to the hardcoded four — same `sourceFileForPath` /
`geminiSessionLayout` / opencode-db matchers). Exactly three upstream files
carry W950 edits, all in the CLI/watch boundary layer:

1. `src/cli/commands/sync.ts` — with no user `--path`,
   `sourcePaths: commandOptions.path ?? sessionSourcePaths(config)`; after
   the report lands, `afterSync()` runs the miss-mint path.
2. `src/cli/context.ts` — `openArchive()` installs the confidence-stamp
   trigger (`ensureConfidenceTable`) before any ingest; the `withArchive`
   auto-sync injects the registry source list.
3. `src/watch.ts` — `runSyncOnce()` opens its own database handle: installs
   the trigger there and injects the registry source list per sweep.

One UI fix carries a fleet divergence (W1107.1.1.2.1, 2026-10-22):
`src/ui/report-export.tsx` replaces upstream's `document.write` popup flow
with the native fetch → `Blob` → object-URL navigation → print path (fleet
UI law: never `document.write`; the report endpoint serves
`content-disposition: attachment`, so fetch+blob is what keeps the popup
on-screen). Re-apply on re-sync.

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
3. Re-apply the three seam edits + the README fleet section.
4. Re-drop the curated test files (list above).
5. `bun install --frozen-lockfile` in this package, run `bun test` (expect
   the upstream suite green), then `bun test fleet/` for ours.
