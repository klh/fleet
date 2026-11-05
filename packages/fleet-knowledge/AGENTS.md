# AGENTS.md — agent contributor protocol

fleet-knowledge is a generic knowledge plane for agent fleets: a
SQLite-backed knowledge store with staged (candidate → verified) writes,
mechanical provenance, an HTTP sink (anonymous scrubbed recall, keyed
NL→SQL and direct SQL recall), a stdio MCP recall face, an ingest worker
with redaction gates, and consult/oracle libraries on top. This file is
the HOW for any agent CLI working here; the docs/ directory is the WHAT.

## Layout

- `src/` — flat modules, one concern each (store, schema, redaction,
  sync policy, merkle/anti-entropy, consult state machine, oracle legs).
  The store port lives in `src/sqlite-store.ts`; the schema home is
  `src/knowledge-db.ts`.
- `bin/` — entry points: `knowledge-api.ts` (the sink), `knowledge-worker.ts`
  (ingest daemon), `knowledge-mcp.ts` (MCP stdio), `oracle.ts`,
  `knowledge-sync.ts` (spoke→hub push).
- `decant/` — vendored token-accounting toolkit (see docs/decant.md).
  Byte-pure: do not edit; fleet seams are documented in its FLEET.md.
- `test/` — the suite. Co-situated tests for new logic.
- `docs/` — architecture, faces, lifecycle, sync, oracle, consult, roadmap.

## Laws

- No `innerHTML`, no `document.write` — anywhere, ever.
- No shell scripts. TypeScript on Bun is the automation surface.
- Files stay under 1200 lines. At 1200, stop and decompose by
  responsibility; 1500 is a hard block.
- zod at every wire boundary where a schema module exists — an HTTP body
  or config file is safeParse'd through a named schema, never hand-cast.
- Every env knob a change reads lands in `.env.example` in the same
  commit. An undocumented knob is a defect.
- Vendored `decant/` is imported, never modified.
- Markdown docs say what the code does. Every knob documented must be
  greppable in src/ or bin/.

## Gates

A change is done when all three pass:

    bun run typecheck
    bun test ./test/
    bunx @biomejs/biome check src bin test

Run them before claiming done; CI runs exactly these.

## Commits and PRs

- Imperative subject; one logical change per commit.
- `Co-Authored-By: Claude Code <noreply@anthropic.com>` welcome on
  agent-authored commits.
- Small anchored edits; never hand-edit a file another live agent owns.
- Security findings go through a private advisory (SECURITY.md), never a
  public issue.
