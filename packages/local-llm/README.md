# packages/local-llm

The local MLX swarm kit: a resident-model supervisor, the model spawner,
and config stubs. The registry and the anthropic router (`:4000`) are
BELT-owned since W465: `registry.ts` here is a re-export of
`packages/belt/bin/registry.ts` (the ONE runtime model inventory) and the
router lives at `packages/belt/bin/router-shim.ts` — the local-llm twin was
retired after the wire-level parity test (belt test/router-shim-parity.test.ts)
proved the shared client surface.

## Layout

**Flat kit** — the package root mirrors the runtime home one-to-one: the
four `.ts` files sit at the root (no `src/`, no `bin/`) because install.sh
copies them individually into a flat directory and they import each other
relatively (`./registry.ts`, `./spawner.ts`).

| File                  | Role                                                          |
| --------------------- | ------------------------------------------------------------- |
| `swarm.ts`            | serve supervisor + status CLI (launchd entrypoint)            |
| `registry.ts`         | RE-EXPORT of belt/bin/registry.ts (the one model inventory)   |
| `spawner.ts`          | mlx-lm process launcher (uv tools, log dirs)                  |
| `belt.env`            | installer stub — env for clients pointing at the belt (:4100) |
| `routing-policy.yaml` | default ladder template — the committed default               |

The `:4000` router is served by `packages/belt/bin/router-shim.ts`
(anthropic wire → openai-protocol specialists); install.sh seeds the
runtime home from belt/bin (W465).

## Port map

| Port    | Specialist                                       |
| ------- | ------------------------------------------------ |
| `:8901` | coder                                            |
| `:8902` | extract / menial                                 |
| `:8903` | reason                                           |
| `:8906` | general / Danish                                 |
| `:4000` | belt router-shim (anthropic seam over the swarm) |

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
— flat layout preserved, history followed the `git mv`. W465 (2026-10-06)
consolidated the model inventory: belt/bin/registry.ts is the single source,
this package re-exports it, and the board reads the registry through
`hooks/lib/service-inventory.ts` (belt-owned), not this copy.
