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

| File                 | Role                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swarm.ts`           | RETIRED W284 — belt/bin/swarm.ts (`supervise`) is the ONE supervisor; installs heal the home from belt/bin                                                                                          |
| `registry.ts`        | RE-EXPORT of belt/bin/registry.ts (the one model inventory)                                                                                                                                         |
| `spawner.ts`         | RE-EXPORT of belt/bin/spawner.ts (the one lifecycle)                                                                                                                                                |
| `litellm-target.ts`  | RE-EXPORT of belt/bin/litellm-target.ts (the one :4100 target)                                                                                                                                      |
| `memory-policy.ts`   | real module — belt/bin/memory-policy.ts is a shim to this                                                                                                                                           |
| `belt.env`           | installer stub for runtime gateway and upstream settings                                                                                                                                            |
| `lane-load-bench.ts` | W452 bench (re-integrated W782.2.1): residency probe + cold/warm TTFT + p95 at the registry's admission concurrency, deterministic quality grading                                                  |
| `models.catalog.ts`  | W754.1 — the ONE model-acquisition catalog: repo/revision/license/runtime bindings pinned to belt's serving registry; the machine `models.catalog.json` adds private entries and wins id collisions |
| `health.ts`          | process-liveness response helper (outside-process sidecars own service health)                                                                                                                      |
| `observation.ts`     | the outside-process observation contract (evidence identity + expiry, written to `~/.claude-insights/belt-supervisor.json`)                                                                         |
| `kill-listeners.ts`  | stops server listeners on a port only (health-check clients survive recovery)                                                                                                                       |

The `:4000` router is served by `packages/belt/bin/router-shim.ts`
(anthropic wire → openai-protocol specialists); install.sh seeds the
runtime home from belt/bin (W465).

## Port map

| Port    | Specialist                                                         |
| ------- | ------------------------------------------------------------------ |
| `:8901` | coder                                                              |
| `:8902` | extract                                                            |
| `:8903` | reason                                                             |
| `:8906` | general / Danish (on-demand)                                       |
| `:8907` | embed (rapid-mlx `/v1/embeddings`; 8904/8905 retired)              |
| `:8912` | kev — external classifier (`com.belt.kev`, observed, not launched) |
| `:8913` | rerank                                                             |
| `:4000` | belt router-shim (anthropic seam over the swarm)                   |
| `:4100` | LiteLLM cloud gateway, supervised separately from the MLX swarm    |
| `:4101` | Buckle authenticated front door, separate service                  |

## Runtime home

W284 (2026-10-15): the belt kit (packages/belt/bin) is the ONLY supervisor
source — the serve supervisor here is retired. Installs heal the runtime
home's belt closure from `packages/belt/bin` (swarm.ts `supervise` + full
import graph); the launchd label is `com.suspenders.belt-swarm` (W640
receipt namespace). The kit keeps the
real modules belt resolves through shims (e.g. memory-policy.ts) and the
config stubs (`belt.env`).

The kit RUNS from `~/.claude/local-llm/`, never from this repo.
`packages/suspenders/install.sh` heals the home's belt closure there
(missing AND diverged files — the belt kit is the source); config stubs
are seeded only when absent. Swarm-specific machine config lives in
that home (mode 600): filled `belt.env`, operator-edited
`routing-policy.json`, `prefs.json`. The committed routing default is
`packages/buckle/routing-policy.json`; repos carry placeholders only.

Operate:

```sh
bun ~/.claude/local-llm/swarm.ts status     # swarm health (read-only)
bun ~/.claude/local-llm/swarm.ts supervise  # resident supervisor
```

launchd label: `com.suspenders.belt-swarm` (`supervise`, KeepAlive).

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

Buckle exposes Copilot models through the configured `claude-*` groups.
The seat supports Anthropic `/v1/messages`, tool calls and SSE. The cloud
transport can route those groups through LiteLLM's `github_copilot/` legs
using the PAT-seeded token cache. The overlay template is
`packages/buckle/upstreams.copilot.json`.

## Config stubs

- `belt.env` — placeholder; `ANTHROPIC_AUTH_TOKEN` is filled at activation
  on the device and the filled copy is NEVER committed.
- `packages/buckle/routing-policy.json` — the committed routing default.
  Operators edit `~/.claude/local-llm/routing-policy.json`; Belt emits the
  cloud gateway settings from that policy.
