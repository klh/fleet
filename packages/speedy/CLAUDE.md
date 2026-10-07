# speedy — config layer law

Speedy is the config layer for the klh stack: skills/, hooks/, commands/,
agents/, bin/ and install.sh (the repo → harness sync). The fleet law set
is mirrored in-repo at docs/laws.md. This file is package law — the tables,
benchmarks and reference detail live in docs/, not here.

## Operating style

- Think before acting; read files before writing. One focused pass — no write-delete-rewrite cycles.
- Verify with real command output before claiming anything works — evidence before assertions.
- Concise output, thorough reasoning; no sycophancy, no filler. Unsure = say so; never invent paths.
- Autonomous on reversible steps; ask before publishing, deleting, or irreversible actions.
- Third-party skills/plugins/MCP are prompt+code injectors — run `skill-security-review` before installing.

## File editing (hook-enforced)

- NEVER create/modify files via shell (`cat >`, `echo >`, `sed -i`, heredocs) — edit-enforce denies; use Edit (unique anchor) / Write (new/whole).
- Bulk mechanical: `sd`/`ambr`; structure-shaped: `ast-grep`; semantic multi-file: Edit per file.
- Fix PostToolUse syntax errors before moving on; verify every 3rd edit by building/running the file.
- More than 5 planned changes to one file: re-read once, whole-file Write; validate before moving on.
- Markdown is prettier-formatted on save; write tables loosely and re-read after bulk writes.

## qlty quality doctrine

- qlty is THE quality tool; `.qlty/` must exist or the on-write gate silently no-ops.
- SPEC FIRST: read `.qlty/qlty.toml` + the biome rule set before the first write; never emit flagged patterns.
- biome owns code formatting; prettier owns markdown only. `qlty check` is diff-aware (changed files only).

## Automation doctrine

- Logic/tooling in TypeScript run by Bun — typed, testable, real parsers; heavy ops via native CLIs with argument arrays, batched.
- Shell scripts are BANNED (LaunchAgent pointers + one-line aliases only). Rust only when profiling proves a bottleneck.

## Skills

- `skills/` is the active set; `skills-available/` is parked and NOT auto-loaded — restore with `git mv`.
- Author/edit skills per docs/skill-anatomy.md; curation and packaging in docs/skill-curation.md.

## Code style

- Modular, DRY on the second duplicate; composition/event mediator; Lit + native web components; platform APIs over wrappers.
- React/Vue maintenance-only, never greenfield. Boring, inspectable, one obvious path.

## Journalism (all agent work)

- LLM outputs are leads, not facts: first-tier sources, never publish unverified, right of reply, corrections documented. Full standard: docs/agent-doctrine.md.

## Detail lives in docs/ (keep this file at budget)

- docs/agent-doctrine.md — speed-tool tables, benchmarks, workflow rules, tool inventory, MCP selection, LLM routing, journalism standard, CLI lessons.
- docs/laws.md — fleet law mirror. docs/skill-anatomy.md + docs/skill-curation.md — skill authoring and curation.
- docs/getting-started.md — install + first run.
