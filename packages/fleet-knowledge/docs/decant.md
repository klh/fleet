# decant — the vendored token-accounting toolkit

`decant/` is a vendored copy of dosu-ai/decant **v0.11.0** (Apache-2.0) —
a token/cost accounting toolkit for agent sessions. It ships its own
package.json and lockfile and is byte-pure apart from documented fleet
seams (recorded in `decant/FLEET.md`).

## What it does

decant ingests agent-session transcripts into a machine-local,
unencrypted SQLite archive (`decant.db`): per-session token counts, cost
estimates, model/tool usage, and durations. Its CLI surfaces are headless
exports and stats (`sync`, `stats --by day|tool|model --format json`),
per-session listing (`ls --json`), and transcript surfacing
(`export` / `show` / `search`).

## How the knowledge layer consumes it

- **CLI subprocess.** The sync layer runs the decant binary as a
  subprocess — `sync -q`, then `stats --by day|tool|model --format json
--no-sync`; per-session grain is opt-in. The binary path is
  config-over-code via knowledge-sync.json's `decantBin` key; the code
  default is the `DECANT_DEFAULT_BIN` constant (`"decant"`, resolved from
  PATH). No `DECANT_*` env knob exists — config is the JSON file.
- **Read-only SQLite reads.** The daily distiller reads `decant.db`
  read-only for its session→claims pass. Writes stay decant's own.
  The archive stays machine-local: its content never crosses a machine
  boundary (the sync class policy), and it is session EVIDENCE — an
  input to capture, never itself a knowledge store.

## Vendoring rules

- `decant/` is imported, never modified. Integration seams are documented
  in `decant/FLEET.md`; any upstream re-vendor updates the version line
  here in the same change.
- Attribution: see [NOTICE](../NOTICE). Upstream license: Apache-2.0 with
  its own LICENSE/NOTICE shipped in-tree.
