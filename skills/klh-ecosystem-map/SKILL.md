---
name: klh-ecosystem-map
description: Orients a fresh agent session on the klh fleet (suspenders, buckle, belt, speedy, klh/local) as one combined system. Use on session start, when asked "why ECONNREFUSED"/"why doesn't X know about Y", or any time a task touches more than one of these repos.
---

# KLH Ecosystem Map

> Part of speedy (https://github.com/klh/speedy) — installed to
> `~/.claude/skills/klh-ecosystem-map` by `install.sh`, symlinked to
> `~/.agents/skills` for every CLI (Claude, Copilot, Codex, cline, grok).

## Overview

suspenders / buckle / belt / speedy / klh/local are **one system**, not five
unrelated repos. A fresh agent session on a newly-installed machine should
know this immediately — this skill is the pointer.

## The five repos

| Repo           | Role                                                                                                                                  | Lives at (after install)                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **speedy**     | Top-level installer/config layer. `install.sh` chains in the other four, installs CLI tools, skills, hooks, launchd agents.           | the git checkout you installed from                                                 |
| **suspenders** | Control plane: governor.db work graph (SQLite/WAL), coord bus, fleet board (:7799), hook gates, fleet-loop (dispatch + merge-ladder). | `~/.claude/hooks/suspenders` (installed copy — **not** the dev checkout, see below) |
| **buckle**     | LLM gateway/router: picks an upstream (local swarm vs remote/z.ai), applies the routing ladder + budgets.                             | `~/.claude/buckle`                                                                  |
| **belt**       | The LLM fleet itself: MLX specialist swarm on localhost (`:8901+`) plus remote/z.ai lanes belt's `remotes.ts` router reaches.         | `~/.claude/local-llm` (registry, swarm.ts, routing-policy.yaml)                     |
| **klh/local**  | LAN fabric: user-level Caddy serving `*.local` names (`suspenders.local`, `belt.local`) over the LAN.                                 | `~/.local/bin/klh-local`                                                            |

Call chain for an LLM request: **surface (Claude/Copilot/VS Code) → belt
(fleet router) → buckle (gateway) → local swarm or remote/z.ai**. suspenders
sits alongside as the control plane (work graph + board + coord), not in the
inference path.

## Install vs. checkout — the split that causes "but I just fixed that!"

Every repo's `install.sh` **copies** the harness into a runtime home —
it does not run in place from the git checkout:

- suspenders → `~/.claude/hooks/suspenders` (`$SUSPENDERS_PREFIX`)
- buckle → `~/.claude/buckle`
- belt → `~/.claude/local-llm`

Editing a dev checkout (`~/github/klh/suspenders`, etc.) has **zero runtime
effect** until `install.sh` re-runs and re-copies. launchd-managed daemons
(`com.suspenders.local-llm`, etc.) run the **installed** copy. After merging
any fix in one of these repos, re-run that repo's `install.sh` (or speedy's,
which chains all of them) to actually deploy it.

## Discovery: `/llms.txt`

Every service in this stack serves a plain-text `GET /llms.txt` self-
description: endpoints, write contracts, companion repos. Check it before
guessing at an API:

- `http://suspenders.local:7799/llms.txt` (or `http://127.0.0.1:7799/llms.txt`)

## Coordination: `coord` CLI

`bun ~/.claude/hooks/suspenders/bin/coord.ts` — the cross-session message
bus, independent of any single PR/branch:

- `coord inbox --as <sid>` — read messages addressed to this session
- `coord message <target> "text" --as <sid>` / `--all` — send one
- `coord broadcast --as <sid> --note "..."` — fan out to every live session
- `coord targets` / `coord fleet` — who's active right now

Poll your inbox at session start and before finishing a task — the fleet
uses this to hand off findings (e.g. "W277 retired com.belt.gateway, don't
re-enable it").

## Work graph: `work` CLI

`bun ~/.claude/hooks/suspenders/bin/work.ts` — the shatterable work-item
tracker backing the fleet board:

- `work add "<title>" --desc "..." --by <sid>` — register an item
- `work take <id> --as <sid>` — claim it (CAS READY→CLAIMED)
- `work split <id> "child one" "child two" --reason ... --keep <n>` —
  decompose into independent children, keep one, let the fleet take the rest
- `work done <id> --as <sid> --sha <sha>` — complete + retire its worktree

Board: `http://suspenders.local:7799` (or `:7799` locally).

## When in doubt

If a task touches ECONNREFUSED/routing/ports, a service being "down", or
any cross-repo question — check `/llms.txt` and `coord fleet` **before**
assuming a single repo's code is the whole story.
