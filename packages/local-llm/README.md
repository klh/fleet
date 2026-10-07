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
runtime modules sit at the root (no `src/`, no `bin/`) because install.sh
copies them individually into a flat directory and they import each other
relatively (`./registry.ts`, `./spawner.ts`).

| File                  | Role                                                          |
| --------------------- | ------------------------------------------------------------- |
| `swarm.ts`            | serve supervisor + status CLI (launchd entrypoint)            |
| `registry.ts`         | RE-EXPORT of belt/bin/registry.ts (the one model inventory)   |
| `spawner.ts`          | mlx-lm process launcher (uv tools, log dirs)                  |
| `gateway-supervision.ts` | LiteLLM adoption, revival and bounded retry backoff |
| `serve-observation.ts` | Bounded network probes and atomic Belt-compatible evidence snapshot |
| `litellm-target.ts` | Re-export of Belt's canonical LiteLLM target |
| `memory-policy.ts` | Per-model Metal budget, bounded caches and concurrency |
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
| `:8913` | reranker |
| `:4000` | belt router-shim (anthropic seam over the swarm) |
| `:4100` | LiteLLM engine, owned by the serving swarm |
| `:4101` | Buckle authenticated front door, separate service |

## Runtime home

The kit RUNS from `~/.claude/local-llm/`, never from this repo.
`packages/suspenders/install.sh` copies the kit there (belt-owned code —
litellm-target, registry, router, admission, spawn kit — converges on hash
mismatch with the pre-refresh copy backed up as `<file>.before-refresh`;
swarm.ts refreshed when the copy lacks `serve`; operator config never
clobbered). Machine config lives ONLY in
that home (mode 600): filled `belt.env`, operator-edited
`routing-policy.yaml`, `prefs.json`. Repos carry placeholders only.

Operate:

```sh
bun ~/.claude/local-llm/swarm.ts status   # swarm health (read-only)
bun ~/.claude/local-llm/swarm.ts serve    # resident supervisor
```

launchd label: `com.suspenders.local-llm` (`serve`, KeepAlive) —
`launchctl kickstart gui/$(id -u)/com.suspenders.local-llm` revives.

The serving kit writes outside-process HTTP observations to
`~/.claude-insights/belt-supervisor.json` every supervision cycle
(`BELT_SUPERVISOR_STATUS` overrides the path). Belt reads this same contract;
expired evidence stays unknown. External services are observed only, missing
on-demand targets are idle only after a refused network connection, and probe
errors remain unknown. Unrecorded gateway restart totals and breaker budgets
stay explicitly unavailable. This observer never launches additional models.

To explicitly replace kit supervision code while preserving machine registry,
routing, tier, credentials and gateway configuration:

```sh
bash packages/suspenders/install.sh --refresh-supervisor --dry-run
bash packages/suspenders/install.sh --refresh-supervisor
launchctl kickstart -k gui/$(id -u)/com.suspenders.local-llm
```

The installer validates staged code imports and saves changed code backups.
It keeps the installed supervisor family: a kit refresh cannot enable the
advanced Belt supervisor. Existing operator code customizations in the four
refreshed kit modules are replaced explicitly and retained in `.serve-backup`
files; ordinary installation continues to preserve existing runtime copies.

### Recover a legacy swarm missing gateway ownership

```sh
bash packages/suspenders/install.sh --refresh-gateway --dry-run
bash packages/suspenders/install.sh --refresh-gateway
launchctl kickstart -k gui/$(id -u)/com.suspenders.local-llm
```

This code-only upgrade preserves runtime customizations, makes backups of
changed modules, and keeps registry, routing policy and credentials intact.
The advanced Belt supervisor already owns LiteLLM and uses
`--refresh-supervisor` instead. Keep `com.belt.gateway` unloaded: there
must be one restarter for port 4100.

Rapid engines receive a model-sized Metal allocation budget (weights × 1.2
plus 4 GiB, capped at 40 GiB), a 1 GiB prefix cache and concurrency of two.
The allocation fraction is calculated against host RAM; Rapid applies it to
its Metal working-set budget, so the effective limit can be lower. Native
idle handling clears caches after 60 seconds and unloads model weights after
15 minutes without inference. Health probes do not count as inference.
Cold admission includes the prospective model budget in the 60 GiB wired-RAM
guard, and a live loading PID is never replaced just because its deadline
expired. These limits constrain each engine; they are not an OS-wide RSS cap
or a transactional reservation across concurrent launchers.

Buckle liveness alone cannot verify inference: recovery verification must
include an authenticated request through its governed route, then revoke the
temporary test key. On 2026-10-07, Buckle was listening while its LiteLLM
backend was absent because the minimal legacy swarm did not supervise it.

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
