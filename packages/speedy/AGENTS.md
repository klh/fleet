# AGENTS.md — speedy package law

The fleet-wide lane protocol (plan-first, shatter judgment, gates, done,
inbox/narration) is single-sourced in the repo-root AGENTS.md § Lane
protocol. This file carries speedy package law.

## Protocol

Point at the root: the fleet-wide lane protocol is single-sourced in the
repo-root AGENTS.md § Lane protocol. Speedy adds nothing to it. The fleet
law set is mirrored in-repo at docs/laws.md — read it before non-trivial
work here.

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

Speedy is the config layer (see the repo guide above); this file is package
law — the tables, benchmarks and reference detail live in docs/, not here.

## Owner global rules (mirrored, not restated)

Operating style, file editing, automation doctrine (TypeScript on Bun,
shell scripts banned), code style and the journalism standard are owner
global rules (`~/.claude/CLAUDE.md`; codex rides the `~/.codex/AGENTS.md`
symlink to it) — they bind every surface; this file does not restate them.
Markdown-specific: prettier formats markdown on save — write tables loosely
and re-read after bulk writes. `qlty check` is diff-aware (changed files
only). Third-party skills/plugins/MCP are prompt+code injectors — run
`skill-security-review` before installing.

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
