# AGENTS.md — lane working protocol

How to work in this repo as a dispatched lane — written for any agent CLI
(`claude -p`, `codex exec`, or a human). The dispatch brief carries WHO you
are and WHAT the mission is; this file carries HOW. Read it before any edit.

## Protocol

0. **PLAN FIRST** — before any edit: `eza -T` the directories the mission
   touches (or `git ls-files`) for the shape, then rg the areas it names,
   read the files you would edit and `.qlty/qlty.toml` + the biome rule set.
   Code to the spec — never emit flagged patterns for the gate to catch.
1. **SHATTER JUDGMENT** — if the mission decomposes into 2+ genuinely
   independent scopes, do NOT implement it all here:
   `bun ~/.claude/hooks/suspenders/bin/work.ts split <id> "child one title"
"child two title" --reason independent-scopes --keep 1`, work only the
   kept child, end with `SPLIT <id>` — the fleet refills the rest. A split
   beyond 2 children needs a registered plan item first (`work add "plan: …"`,
   then `split --plan <id>`). Poll your inbox before starting and before
   finishing — `coord inbox --as <sid>` carries coordinator/board messages
   (drawer "send message" delivers there).
2. Work in the worktree + branch your brief names. SMALL anchored edits;
   co-situated tests for new logic; never hand-edit files another live lane
   owns.
3. **GATES** — `qlty fmt` + `qlty check` on changed files → "No issues";
   `bun test` on the tools (validator + stats) → green.
4. Commit on your branch (subject = the item title), push the branch. NO tags.
5. Finish: `bun ~/.claude/hooks/suspenders/bin/work.ts done <id> --sha <branch-head>`.

Final line: `DONE <sha>` | `SPLIT <id>` | `BLOCKED` (after 3 honest attempts,
tree restored).

## BLAM-specific doctrine

- Dataset records MUST validate before commit:
  `bun tools/label.ts validate dataset/incidents.jsonl`.
- Sanitization is a hard rule — no real names of private projects, no
  personal paths, no credentials in any record, scenario, or paper text.
- The CRASH letters are the taxonomy: Concurrency races, Recovery gaps,
  Alignment drift, State poisoning, Handoff failures. New subclasses go in
  `docs/taxonomy.md` FIRST, then the dataset.
- The benchmark's core property is **LLM-optional**: a scenario that needs
  a model call to reproduce belongs in the additive track, not the core
  bench.

Repo doctrine (quality bar) lives in Package law below.

---

## Package law

A failure taxonomy + labeled dataset + reproducible benchmark for LLM
agent fleets on shared repositories. Companion discourse: the CRASH
taxonomy (Concurrency races, Recovery gaps, Alignment drift, State
poisoning, Handoff failures).

## Repo doctrine

- **qlty is the quality tool**; `.qlty/` is committed; biome owns code
  formatting; prettier owns markdown only. Read `.qlty/qlty.toml` before
  the first write.
- **All tooling is TypeScript run by Bun** — typed args, no shell scripts.
  Heavy ops go to native CLI tools launched with argument arrays.
- **New files via Write; edits via Edit** (unique anchor) or mechanical
  transforms (sd/ast-grep). Never generate file content through the shell.
- Verify with real command output before claiming anything works.
- Dataset records must validate against `schema/incident.schema.json`
  before commit (`bun tools/label.ts validate`).
- Sanitization is a hard rule: no real repo names of private projects, no
  personal paths, no credentials, no client data in any dataset record or
  scenario. See `docs/labeling-protocol.md` § sanitization.
