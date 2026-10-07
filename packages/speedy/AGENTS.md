# AGENTS.md — lane working protocol

How to work in this repo as a dispatched lane — written for any agent CLI
(`claude -p`, `codex exec`, or a human). The dispatch brief carries WHO you
are and WHAT the mission is; this file carries HOW. Read it before any edit.

## Protocol

0. **PLAN FIRST** — before any edit: `eza -T` the directories the mission
   touches (or `git ls-files`) for the shape, then rg the areas it names,
   read the files you would edit and `.qlty/qlty.toml` + the biome rule set.
   Code to the spec — never emit flagged patterns for the gate to catch.
   Note what live lanes already own: the governor denies parallel edits to
   a leased file; re-read and retry, it integrates rather than blocks.
1. **SHATTER JUDGMENT** — if the mission decomposes into 2+ genuinely
   independent scopes, do NOT implement it all here:
   `bun ~/.claude/hooks/suspenders/bin/work.ts split <id> "child one title"
"child two title" --reason independent-scopes --keep 1`, work only the
   kept child, end with `SPLIT <id>` — the fleet refills the rest. A split
   beyond 2 children needs a registered plan item first (`work add "plan: …"`,
   then `split --plan <id>`). Your inbox is WS-first (W303): bootstrap
   opens `coord subscribe --as <sid>` at session start — one persistent
   push connection; never poll it. `coord inbox --as <sid>` is the
   catch-up read before starting and before finishing — coordinator/board
   messages arrive there (drawer "send message" delivers there).
2. Work in the worktree + branch your brief names. SMALL anchored edits;
   co-situated tests for new logic; never hand-edit files another live lane
   owns.
3. **GATES** — `qlty fmt` + `qlty check` on changed files → "No issues";
   `bun test` on the files you touched → green.
4. Commit on your branch (subject = the item title), push the branch. NO tags.
5. Finish: `bun ~/.claude/hooks/suspenders/bin/work.ts done <id> --sha <branch-head>`.

Final line: `DONE <sha>` | `SPLIT <id>` | `BLOCKED` (after 3 honest attempts,
tree restored).

Repo doctrine (quality bar, architecture) lives in Package law below.
The fleet law set is mirrored in-repo at docs/laws.md — read it before non-trivial work here.

---

# Repo guide

speedy is the config layer for the klh stack: skills/ (active set),
skills-available/ (parked — restore with `git mv`), hooks/, commands/,
agents/, bin/, statusline.ts, install.sh (the ONLY repo → harness sync),
install-codex.ts (codex harness install).

- Creating or editing a skill: docs/skill-anatomy.md (SKILL.md format, naming, progressive disclosure).
- Curation, packaging (zip), script requirements, installation, skills quick reference: docs/skill-curation.md.
- Tooling detail (speed tools, benchmarks, inventory, MCP selection): docs/agent-doctrine.md.

---

## Package law

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
