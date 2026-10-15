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
| `swarm.ts`            | RETIRED W284 — belt/bin/swarm.ts (`supervise`) is the ONE supervisor; installs heal the home from belt/bin |
| `registry.ts`         | RE-EXPORT of belt/bin/registry.ts (the one model inventory)   |
| `spawner.ts`          | RE-EXPORT of belt/bin/spawner.ts (the one lifecycle)          |
| `litellm-target.ts`   | RE-EXPORT of belt/bin/litellm-target.ts (the one :4100 target) |
| `memory-policy.ts`    | real module — belt/bin/memory-policy.ts is a shim to this     |
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
| `:4100` | LiteLLM engine, owned by the belt supervisor |
| `:4101` | Buckle authenticated front door, separate service |

## Runtime home

W284 (2026-10-15): the belt kit (packages/belt/bin) is the ONLY supervisor
source — the serve supervisor here is retired. Installs heal the runtime
home's belt closure from `packages/belt/bin` (swarm.ts `supervise` + full
import graph); the launchd label is `com.belt.swarm`. The kit keeps the
real modules belt resolves through shims (e.g. memory-policy.ts) and the
config stubs (`belt.env`).

The kit RUNS from `~/.claude/local-llm/`, never from this repo.
`packages/suspenders/install.sh` heals the home's belt closure there
(missing AND diverged files — the belt kit is the source); config stubs
are seeded only when absent. Machine config lives ONLY in
that home (mode 600): filled `belt.env`, operator-edited
`routing-policy.yaml`, `prefs.json`. Repos carry placeholders only.

Operate:

```sh
bun ~/.claude/local-llm/swarm.ts status     # swarm health (read-only)
bun ~/.claude/local-llm/swarm.ts supervise  # resident supervisor
```

launchd label: `com.belt.swarm` (`supervise`, KeepAlive).

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
bash packages/suspenders/install.sh --refresh-supervisor
```

The installer heals the home's belt closure from the belt kit (backup,
refresh, import validation; a failed validation restores the previous
code). W284 retired the serve-era refresh verbs (`--refresh-gateway` and
refresh-swarm.ts) together with the fork they patched.

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

## IKEA Copilot seat (W695.6 — replaces ikea-shim W226)

No shim, no `:4102`. Buckle serves the claude-* lane models straight from the
Copilot seat (Anthropic-wire `/v1/messages` on api.githubcopilot.com, Bearer
`GITHUB_COPILOT_PAT` from the 0600 `copilot.key` chain). Overlay template:
`packages/buckle/upstreams.copilot.yaml`.

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
