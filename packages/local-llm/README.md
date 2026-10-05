# packages/local-llm

The local MLX swarm kit: a resident-model supervisor, the specialist
registry, the model spawner, and the anthropic router-shim (`:4000`, the
Anthropic↔OpenAI translation seam lanes ride).

## Layout

**Flat kit** — the package root mirrors the runtime home one-to-one: the
four `.ts` files sit at the root (no `src/`, no `bin/`) because install.sh
copies them individually into a flat directory and they import each other
relatively (`./registry.ts`, `./spawner.ts`).

| File                  | Role                                                           |
| --------------------- | -------------------------------------------------------------- |
| `swarm.ts`            | serve supervisor + status CLI (launchd entrypoint)             |
| `registry.ts`         | specialist table — model → port, tiers, fallbacks              |
| `spawner.ts`          | mlx-lm process launcher (uv tools, log dirs)                   |
| `router-shim.ts`      | anthropic-wire server on `:4000` → openai-protocol specialists |
| `belt.env`            | installer stub — env for clients pointing at the belt (:4100)  |
| `routing-policy.yaml` | default ladder template — the committed default                |

## Port map

| Port    | Specialist                                  |
| ------- | ------------------------------------------- |
| `:8901` | coder                                       |
| `:8902` | extract / menial                            |
| `:8903` | reason                                      |
| `:8906` | general / Danish                            |
| `:4000` | router-shim (anthropic seam over the swarm) |

## Runtime home

The kit RUNS from `~/.claude/local-llm/`, never from this repo.
`packages/suspenders/install.sh` copies the kit there (registry/spawner/
router-shim only when absent, swarm.ts refreshed when the copy lacks
`serve`, config stubs never clobbered — the runtime copy is the live
fleet's possibly-customized source of truth). Machine config lives ONLY in
that home (mode 600): filled `belt.env`, operator-edited
`routing-policy.yaml`, `prefs.json`. Repos carry placeholders only.

Operate:

```sh
bun ~/.claude/local-llm/swarm.ts status   # swarm health (read-only)
bun ~/.claude/local-llm/swarm.ts serve    # resident supervisor
```

launchd label: `com.suspenders.local-llm` (`serve`, KeepAlive) —
`launchctl kickstart gui/$(id -u)/com.suspenders.local-llm` revives.

## Config stubs

- `belt.env` — placeholder; `ANTHROPIC_AUTH_TOKEN` is filled at activation
  on the device and the filled copy is NEVER committed.
- `routing-policy.yaml` — the default ladder template (glm-5.3-flash →
  local-swarm → gpt-5.2 → claude-sonnet-5, never flashx). Belt emits it as
  litellm router_settings; buckle resolves the runtime copy by default.
  Operators edit `~/.claude/local-llm/routing-policy.yaml`, never code.

## Provenance

Extracted from `packages/suspenders/hooks/local-llm/` (W422.4, 2026-10-05)
— flat layout preserved, history followed the `git mv`. The board's
`hooks/board/local-swarm.ts` keeps importing the registry via the
harness-relative prefix copy (`../local-llm/registry.ts`), which install.sh
refreshes from this package on every install.
