# Using speedy-claude with OpenAI Codex CLI

Codex CLI has grown a config surface that overlaps heavily with Claude Code: layered instruction files, skills (same open standard), lifecycle hooks with near-identical event contracts, subagents, and MCP. This doc inventories everything speedy-claude ships, maps it onto Codex's config surface, and gives the porting recipe per element.

**Matrix verdicts:** ✅ native · 🔁 translate (mechanical) · ⚠️ partial (behavioral loss) · ❌ no equivalent.

**Automated install:** `bun install-codex.ts` executes this guide (§1–§6) as an idempotent installer, translating §7 MCP servers from the repo's `.mcp.json` and skipping the §8 elements by design. `--dry-run` previews; `--skip-doctrine|skills|prompts|hooks|agents|mcp|permissions` narrows the run.

All Codex facts below were verified against the official docs at learn.chatgpt.com / developers.openai.com on **2026-09-28** (sources listed at the bottom). Codex moves fast — re-check before relying on a verdict.

## TL;DR

| Verdict            | speedy-claude elements                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅ ports natively  | `skills/` (36, open agent-skills standard), repo `AGENTS.md`, `install.sh` tool layer, MCP servers                                                     |
| 🔁 mechanical port | `commands/` (6 slash commands), hooks block, `.mcp.json`, `agents/` personas (md → toml)                                                               |
| ⚠️ partial         | CLAUDE.md doctrine (size cap), permissions allow/deny lists (sandbox-first model instead), `defaultMode: acceptEdits` (closest posture, no direct key) |
| ❌ no equivalent   | custom statusline scripts (both), z.ai Anthropic-API provider routing (`wire_api` responses-only)                                                      |

## Codex config surface (primer)

| What                | Where                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home / config       | `~/.codex/config.toml` (user); `.codex/config.toml` (project, trust-gated; provider/notify/telemetry keys ignored there); profiles as `$CODEX_HOME/<name>.config.toml` + `--profile`                                                                                              |
| Instructions        | `AGENTS.md`: global `~/.codex/AGENTS.md` (or `AGENTS.override.md`), then repo root → cwd, one file per dir, concatenated root-down. Knobs: `project_doc_fallback_filenames`, `project_doc_max_bytes` (default **32 KiB**)                                                         |
| Skills              | Open agent-skills standard (`SKILL.md` + `scripts/` + `references/`). Repo `.agents/skills`, user `~/.agents/skills`, admin `/etc/codex/skills`. `$skill` / `/skills`; `[[skills.config]]` toggles. Symlinked folders are followed                                                |
| Custom prompts      | `~/.codex/prompts/*.md` → `/prompts:<name>`, `$ARGUMENTS`/`$1`–`$9`. **Deprecated** in favor of skills                                                                                                                                                                            |
| Hooks               | `hooks.json` or inline `[hooks]` (user + project layers). Events: `SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStop`, `Stop`, `Interrupt`, `SessionEnd`                           |
| Subagents           | Built-ins `default`/`worker`/`explorer`; custom agents as `~/.codex/agents/*.toml` / `.codex/agents/*.toml` (`name` + `description` + `developer_instructions`, optional `model`, `model_reasoning_effort`, sandbox overrides). `[agents]` table for globals; `/agent` to inspect |
| MCP                 | `[mcp_servers.<id>]` in config.toml — stdio (`command`/`args`/`env`/`cwd`) and HTTP (`url`, `bearer_token_env_var`, `http_headers`, OAuth), per-tool approval + timeouts                                                                                                          |
| Approvals / sandbox | `approval_policy` (`on-request`/`never`; `untrusted` removed, `on-failure` deprecated; granular sub-rules incl. `skill_approval`), `sandbox_mode` (`read-only`/`workspace-write`/`danger-full-access`)                                                                            |
| Permission profiles | **Beta.** `[permissions.<name>]` with filesystem glob rules (`read`/`write`/`deny`), network domain allow/deny, `extends`; `default_permissions` selects one. Does not compose with older `sandbox_mode` settings                                                                 |
| Provider / model    | `model`, `model_provider`, `model_providers.<id>` (`base_url`, `env_key`, `wire_api` — **only `"responses"` is supported**), `model_reasoning_effort` (`low`→`ultra`)                                                                                                             |
| Status line         | `tui.status_line`: ordered list of **built-in footer identifiers** only, or `null`. No custom-script statusline                                                                                                                                                                   |
| Hook trust          | Non-managed hooks must be reviewed/trusted via `/hooks` (hash-pinned); `--dangerously-bypass-hook-trust` exists for one-offs; `[features] hooks = false` disables                                                                                                                 |

Hook command contract (relevant for porting): every command hook gets one JSON object on **stdin** — `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, plus `permission_mode` with values literally named `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. Output: JSON `continue`/`stopReason`/`systemMessage`, `decision: "block"`, or exit code `2` + stderr. Timeouts in **seconds** (default 600; `SessionEnd`/`Interrupt` default 1s, max 3s).

## speedy-claude config-surface inventory

What the repo ships and where it installs (counts from the working tree):

| #   | Element                     | In repo                                         | Installs to                                                             | Purpose                                                                   |
| --- | --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Doctrine (42,777 B)         | `CLAUDE.md`                                     | `~/.claude/CLAUDE.md`                                                   | Operating style, tool tables, routing doctrine                            |
| 2   | Repo agent guide (3,616 B)  | `AGENTS.md`                                     | stays in repo                                                           | Skill packaging conventions                                               |
| 3   | Settings template (4,797 B) | `settings.example.json`                         | `~/.claude/settings.json`                                               | env/model, 64-entry Bash allowlist + deny/ask, 7 hook events, statuslines |
| 4   | Hook scripts (bun/TS)       | `hooks/*.ts` + suspenders gates                 | `~/.claude/hooks/`                                                      | Session bookkeeping, edit/bash gates, insight recall, PA prefix           |
| 5   | Slash commands              | `commands/*.md` (6)                             | `~/.claude/commands/`                                                   | build / plan / review / ship / spec / test                                |
| 6   | Skills                      | `skills/` (36) + `skills-available/`            | `~/.claude/skills/`                                                     | SKILL.md workflow packages                                                |
| 7   | Agent personas              | `agents/*.md` (16)                              | `~/.claude/agents/`                                                     | Claude subagent manifests (frontmatter persona)                           |
| 8   | Statusline scripts          | `statusline.ts`, `hooks/subagent-statusline.ts` | `~/.claude/`                                                            | Session/agent panel in the footer                                         |
| 9   | Project MCP                 | `.mcp.json`                                     | project `.mcp.json` + `claude mcp add` entries                          | serena, chrome-devtools, context7                                         |
| 10  | Tool installer              | `install.sh`                                    | brew/cargo/npm/qlty + git pager + zoxide + suspenders/belt/LaunchAgents | The CLI-tool speed layer                                                  |
| 11  | Docs                        | `docs/` (per-tool guides)                       | —                                                                       | This doc's siblings                                                       |

## Portability matrix

| speedy element                                                | Codex equivalent                                                    | Verdict | Notes                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo `AGENTS.md`                                              | Read natively (same filename)                                       | ✅      | Codex discovers repo-root `AGENTS.md` by default, root→cwd precedence                                                                                                                                                                              |
| `CLAUDE.md` doctrine (42,777 B)                               | `~/.codex/AGENTS.md` or fallback filename                           | ⚠️      | Point `project_doc_fallback_filenames = ["CLAUDE.md"]` and **raise `project_doc_max_bytes`** — the file exceeds the 32 KiB default and would be silently truncated; or split per-directory                                                         |
| Hooks block (7 events, bun gates)                             | `hooks.json` / `[hooks]` with the same event names                  | 🔁      | Near-1:1: same matchers, `command`, `timeout` (seconds), `statusMessage`, stdin JSON contract, `decision: "block"`, exit-2. Deltas: trust review via `/hooks`, `SessionEnd` ≤3s, tool names differ (`apply_patch`, unified exec matched as `Bash`) |
| `commands/*.md` slash commands                                | `~/.codex/prompts/*.md` (`/prompts:<name>`) — deprecated; or skills | 🔁      | `$ARGUMENTS` placeholders port directly; the skills route (`.agents/skills/<name>/SKILL.md`) is the blessed path and adds implicit triggering                                                                                                      |
| `skills/` (36 SKILL.md packages)                              | `.agents/skills/` (repo) / `~/.agents/skills/` (user)               | ✅      | Same open standard (agentskills.io) — same `SKILL.md` frontmatter, scripts, references. Symlinks are followed, so `ln -s ~/.claude/skills ~/.agents/skills` is a valid zero-copy install                                                           |
| `agents/*.md` personas (16)                                   | `.codex/agents/*.toml` / `~/.codex/agents/*.toml`                   | 🔁      | Different format: TOML with `name` + `description` + `developer_instructions` (+ optional `model`, `model_reasoning_effort`). Frontmatter persona prose moves into `developer_instructions`                                                        |
| `permissions.allow` (64 Bash prefixes)                        | Nothing prefix-shaped at user level                                 | ⚠️      | Codex is sandbox-first: filesystem/network _permission profiles_ (beta) + `approval_policy` granular rules. Admin `rules.prefix_rules` (requirements.toml/`.rules`) can only `prompt` or `forbid`, never allow                                     |
| `permissions.deny` / `ask` (`.env` reads, `rm -rf`)           | `[permissions.<name>.filesystem]` glob `deny` entries               | ⚠️      | `"**/*.env" = "deny"` ports the guardrail intent (beta feature; requires `default_permissions` and dropping `sandbox_mode`)                                                                                                                        |
| `defaultMode: "acceptEdits"`                                  | `approval_policy` + `sandbox_mode`/`default_permissions` pair       | ⚠️      | Closest posture: `sandbox_mode = "workspace-write"` with `approval_policy = "on-request"`. Codex's own permission modes are named `acceptEdits`/`plan`/`dontAsk`/`bypassPermissions` internally, but there is no per-mode setting key              |
| `env` block (z.ai via `ANTHROPIC_BASE_URL` + model overrides) | `model_providers.<id>` (`base_url`, `env_key`)                      | ❌      | `wire_api` supports **only `"responses"`** — an Anthropic-Messages-compat endpoint like z.ai's cannot be pointed at Codex; needs a Responses-API-compatible provider (or the built-in OpenAI/oss providers)                                        |
| `model` / `effortLevel`                                       | `model` + `model_reasoning_effort`                                  | ✅      | Direct mapping (`xhigh` exists on both sides)                                                                                                                                                                                                      |
| `statusLine` + `subagentStatusLine`                           | `tui.status_line` (built-in identifiers only)                       | ❌      | No custom-script statusline; fleet panel/statusline.ts has no Codex surface. `notify` covers turn-finished notifications only                                                                                                                      |
| `.mcp.json` (serena)                                          | `[mcp_servers.serena]` in `.codex/config.toml`                      | 🔁      | JSON → TOML; project-scoped is allowed (only provider/notify/telemetry keys are user-level-only). Per-server `enabled`/`startup_timeout_sec`/per-tool approval available                                                                           |
| `install.sh` CLI-tool layer                                   | Agent-independent — works as-is                                     | ✅      | fd/rg/bat/sd/difft/qlty/… serve whichever agent runs them; git pager + zoxide are agent-agnostic. The suspenders/belt/LaunchAgent payload is Claude-scoped (below)                                                                                 |
| Suspenders control plane (gates, work graph, board)           | Hooks port; CLI is agent-agnostic                                   | ⚠️      | `gate.ts pre-bash`/`pre-files`/`post-files`/`stop`/`governor` are plain stdin-JSON programs and mostly work unchanged; expect tool-name matcher drift and test each gate before trusting it                                                        |

## Porting guide

### 1. Instructions (AGENTS.md / CLAUDE.md)

Codex already reads `AGENTS.md`. For the doctrine file, either symlink it as the global instructions or add the fallback name:

```toml
# ~/.codex/config.toml
project_doc_fallback_filenames = ["CLAUDE.md", "AGENTS.md"]
project_doc_max_bytes = 65536 # CLAUDE.md is 42,777 B — the 32 KiB default truncates it
```

Verify: `codex --ask-for-approval never "Summarize the current instructions."` should quote doctrine items. For always-loaded global doctrine, `~/.codex/AGENTS.md` is the canonical home; keep repo rules in the repo file.

### 2. Skills (zero-copy)

```bash
mkdir -p ~/.agents
ln -s ~/.claude/skills ~/.agents/skills          # user scope, follows symlinks
```

Per-repo alternative: `ln -s ~/.claude/skills .agents/skills`. Codex scans cwd → repo root; `$<name>` invokes explicitly, description-matching triggers implicitly. Toggle individual skills with `[[skills.config]]` (`path` + `enabled = false`).

### 3. Slash commands

Copy `commands/<name>.md` to `~/.codex/prompts/<name>.md` — the frontmatter and `$ARGUMENTS`-style placeholders port as-is (invoke `/prompts:<name>`). Since custom prompts are deprecated, prefer wrapping anything you want implicitly triggered as a skill:

```
.agents/skills/build/SKILL.md   # description: Implement the next task incrementally — build, test, verify, commit
```

### 4. Hooks

Translate the `hooks` block of `settings.example.json` into `~/.codex/hooks.json` — event names, matchers, `command`, `timeout` (seconds), and `statusMessage` carry over:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bun $HOME/.claude/hooks/suspenders/gate.ts pre-bash",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|apply_patch",
        "hooks": [
          {
            "type": "command",
            "command": "bun $HOME/.claude/hooks/suspenders/gate.ts post-files",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Gotchas: matchers must match Codex tool names (`apply_patch` for file edits, unified exec surfaces as `Bash`); run `/hooks` and trust each definition (hash-pinned — edits re-trigger review); `SessionEnd` hooks cap at 3s, so the session-end bookkeeping needs `async` or trimming; hook stdin/output is Claude-compatible, but speedy's gates parse Claude payloads — smoke-test each gate (`gate.ts pre-bash` reads `tool_input.command`) before trusting enforcement.

### 5. Subagent personas

Each `agents/*.md` persona becomes a TOML file. Example (`agents/code-reviewer.md` → `~/.codex/agents/code-reviewer.toml`):

```toml
name = "code-reviewer"
description = "Senior code reviewer across correctness, readability, architecture, security, performance"
developer_instructions = """
<paste the persona body from the .md file here>
"""
# optional: model = "gpt-6-luna"
# optional: model_reasoning_effort = "high"
```

Spawn via prompts ("spawn one code-reviewer subagent…"); `/agent` inspects threads. `[agents]` globals (`default_subagent_model`, `max_concurrent_threads_per_session`) roughly replace `CLAUDE_CODE_SUBAGENT_MODEL`.

### 6. Permissions posture

No port of the 64-entry allowlist — Codex gates by sandbox, not by command prefix. Map the _intent_:

```toml
# ~/.codex/config.toml  (beta profiles; drop sandbox_mode when using these)
default_permissions = "speedy"

[permissions.speedy]
extends = ":workspace"

[permissions.speedy.filesystem]
"**/*.env"        = "deny"
"**/credentials*" = "deny"
"**/*.pem"        = "deny"
```

Without profiles: `sandbox_mode = "workspace-write"` + `approval_policy = "on-request"` is the honest equivalent of `acceptEdits`. Secret-scanning stays with `gitleaks` (already in install.sh) — hook-based blocking is better done via a `PreToolUse` hook than via profile rules.

### 7. MCP servers

```toml
# .codex/config.toml (project) or ~/.codex/config.toml (user)
[mcp_servers.serena]
command = "serena"
args = ["start-mcp-server", "--context", "codex"]
```

`chrome-devtools-mcp` and `context7` install the same way (`command = "npx"`, `args = [...]`, or `url = ...` for streamable HTTP). Per-server `enabled = false` beats deletion when a server misbehaves.

### 8. What deliberately does not port

- **statusline.ts / subagent-statusline.ts** — Codex exposes only built-in footer items (`tui.status_line`). The fleet board URL hyperlink has no Codex surface.
- **z.ai provider routing** — `wire_api = "responses"` only; the Anthropic-compat endpoint cannot serve Codex. Codex side stays on OpenAI auth or an oss/local provider (`oss_provider`, built-in `ollama`/`lmstudio`).
- **suspenders session model** (session-start/end bookkeeping, subagent statusline, insight PA prefix) — hooks fire, but the data plane (session registry keyed on Claude Code session JSON) needs adapter work before the board reflects Codex sessions.

## Verification checklist

```bash
codex status                                        # workspace root + trust + config layer
codex --ask-for-approval never "Summarize the current instructions."   # AGENTS.md/CLAUDE.md loaded
/skills                                             # 36 skills visible, descriptions intact
/hooks                                              # hook sources listed → review + trust each
/agent                                              # custom agents appear
echo '{ "tool_input": { "command": "fd --version" } }' | bun ~/.claude/hooks/suspenders/gate.ts pre-bash   # gate still parses
```

## Sources

All Codex behavior claims verified 2026-09-28 against official OpenAI documentation:

- Config reference: `developers.openai.com/codex/config-reference` (`mcp_servers.*`, `model_providers.*.wire_api`, `tui.status_line`, `project_doc_*`, `skills.config`, `hooks`, `rules.prefix_rules`)
- Hooks: `learn.chatgpt.com/docs/hooks` (events, stdin JSON fields, `permission_mode` values, trust flow, timeout defaults)
- AGENTS.md: `learn.chatgpt.com/docs/agent-configuration/agents-md` (discovery, 32 KiB default, fallback filenames)
- Skills: `learn.chatgpt.com/docs/build-skills` and `/docs/skills-and-plugins` (`.agents/skills` scopes, symlink support, `agents/openai.yaml`, deprecated prompts)
- Subagents: `learn.chatgpt.com/docs/agent-configuration/subagents` (`.codex/agents/*.toml` custom agents, `[agents]` globals)
- MCP: `learn.chatgpt.com/docs/extend/mcp`; Permissions (beta): `learn.chatgpt.com/docs/permissions`; Custom prompts: `learn.chatgpt.com/docs/custom-prompts`

speedy-claude numbers (file sizes, counts) measured in this repo's working tree on the same date.
