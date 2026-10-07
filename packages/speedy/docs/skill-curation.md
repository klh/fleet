# Skill Curation

**Skill curation:** `skills/` holds the actively-maintained set. Skills that fell out of use live in `skills-available/` and are NOT auto-loaded — restore with `git mv skills-available/<name> skills/`. New skills go in `skills/` only if they'll be used; otherwise `skills-available/`. Use `incremental-implementation` for multi-file changes: implement a small slice, test, verify and commit before expanding.

## Skills quick reference

Active skills live in `skills/` (klh-\* variants + registry adds; optional ones parked in `skills-available/`). Check this list when a task matches; invoke the skill before starting.

### Editing & Code Intelligence

| Skill                         | When to use                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `klh-cli-speed-tools`         | ANY terminal file operation — listing, searching, reading files                              |
| `klh-code-simplifier`         | Simplifying, refactoring, or cleaning up existing code                                       |
| `klh-find-bugs`               | Reviewing changes for bugs, security vulnerabilities, code quality                           |
| `ast-grep`                    | Writing ast-grep rules for structural code search/rewrite beyond text search                 |
| `docker`                      | ANY container work — Dockerfile/compose authoring, debugging, networking, Buildx             |
| `az`                          | Azure CLI auth checks, subscription context, resource/deployment lookups                     |
| `sqlite`                      | SQLite queries (read-only safe scripts), backups, health checks, diffing                     |
| `zsh`                         | Reading/debugging/editing zsh config or scripts — setopt, globbing, ZLE, compinit            |
| `md-format`                   | Markdown conventions — GFM-first; mechanical formatting is automatic via the post-files gate |
| `sql-best-practice`           | Idiomatic SQL review, schema work, query tuning                                              |
| `csharp-best-practice`        | Idiomatic C# review — conventions, structure, testing, tooling (.NET repos)                  |
| `klh-openapi-directory-first` | Working with ANY public API — check openapi-directory before training data or web search     |

### Frontend & UI

| Skill                           | When to use                                                             |
| ------------------------------- | ----------------------------------------------------------------------- |
| `klh-core-components`           | Building UI, using design tokens, or working with the component library |
| `klh-lit-dev`                   | Creating Lit web components with TypeScript                             |
| `browser-testing-with-devtools` | Browser testing, DOM/console/network inspection via Chrome DevTools MCP |

### Validation & Testing

| Skill                     | When to use                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `klh-zod-validation`      | Zod runtime validation + deriving JSON Schema/OpenAPI/Postman contracts from zod schemas |
| `zod4`                    | Using Zod 4 schema validation library                                                    |
| `test-driven-development` | Before implementing ANY feature or bugfix                                                |

### Debugging & Planning

| Skill                        | When to use                                                             |
| ---------------------------- | ----------------------------------------------------------------------- |
| `klh-systematic-debugging`   | Bugs, test failures, unexpected behavior — root cause before any fix    |
| `spec-driven-development`    | Starting a new project/feature with no specification                    |
| `context-engineering`        | Setting up or repairing agent context/rules files for a project         |
| `incremental-implementation` | Multi-file changes: implement, test, verify and commit each small slice |

### Docs & Setup

| Skill                         | When to use                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `klh-agents-md`               | Creating/maintaining AGENTS.md / CLAUDE.md agent docs                                   |
| `klh-project-memory`          | Setting up structured project memory in docs/project_notes/                             |
| `klh-settings-audit`          | Auditing/generating a project's Claude Code settings.json permissions                   |
| `skill-lookup`                | Search and install skills from the prompts.chat registry                                |
| `skill-security-review`       | Mandatory security audit BEFORE installing any third-party skill, plugin, or MCP server |
| `find-skills`                 | Discover and install agent skills                                                       |
| `git-workflow-and-versioning` | Committing, branching, organizing parallel work streams                                 |

### Local additions (installed beyond the speedy repo)

| Skill                            | When to use                                                             |
| -------------------------------- | ----------------------------------------------------------------------- |
| `klh-dispatch`                   | Single entry-point orchestrator routing tasks to the right klh-\* skill |
| `klh-testing-patterns`           | Jest factories, mocking strategies, TDD workflow                        |
| `brainstorming`                  | Before creative work — explores intent/requirements/design              |
| `writing-plans`                  | Have requirements for a multi-step task, before touching code           |
| `verification-before-completion` | Before claiming work is done/committed — evidence before assertions     |
| `requesting-code-review`         | Completing tasks or major features, before merge                        |
| `receiving-code-review`          | Processing review feedback with technical rigor                         |
| `dinero-regnskab`                | Visma Dinero bookkeeping automation (browser)                           |

## Context efficiency, script requirements, packaging, installation

Skills are loaded on-demand — only the skill name and description are loaded at startup. The full `SKILL.md` loads into context only when the agent decides the skill is relevant. To minimize context usage:

- **Keep SKILL.md under 500 lines** — put detailed reference material in separate files
- **Write specific descriptions** — helps the agent know exactly when to activate the skill
- **Use progressive disclosure** — reference supporting files that get read only when needed
- **Prefer scripts over inline code** — script execution doesn't consume context (only output does)
- **File references work one level deep** — link directly from SKILL.md to supporting files

### Script Requirements

- Use `#!/bin/bash` shebang
- Use `set -e` for fail-fast behavior
- Write status messages to stderr: `echo "Message" >&2`
- Write machine-readable output (JSON) to stdout
- Include a cleanup trap for temp files
- Reference the script path as `/mnt/skills/user/{skill-name}/scripts/{script}.sh`

### Creating the Zip Package

After creating or updating a skill:

```bash
cd skills
zip -r {skill-name}.zip {skill-name}/
```

### End-User Installation

Document these two installation methods for users:

**Claude Code:**

```bash
cp -r skills/{skill-name} ~/.claude/skills/
```

**claude.ai:**
Add the skill to project knowledge or paste SKILL.md contents into the conversation.

If the skill requires network access, instruct users to add required domains at `claude.ai/settings/capabilities`.
