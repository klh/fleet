<div align="center">

# fleet

### The klh agent stack

**Give agents work. Keep them coordinated. Route their models. See what happened.**

One monorepo for the tools that turn individual coding agents into an operated fleet.

[The stack](#the-stack) · [Architecture](#how-it-fits-together) · [Get started](#get-started) · [Benchmarks](benchmarks.md) · [Migration status](#migration-status)

</div>

---

Fleet brings together the developer environment, agent control plane, LLM gateway,
local model fleet, service front, and failure benchmarks. Work has an identity,
lanes have claims and credentials, decisions reach the operator, and completed
items carry commit evidence.

Use it to coordinate coding agents on shared repositories, run specialist models
on an Apple Silicon Mac, or operate hubs with connected spokes. Local inference,
cloud providers, and federation are configurable parts of the stack.

> **Migration snapshot · 5 October 2026**
> Seven package directories are present and the local-LLM kit is extracted. Workspace wiring,
> a clean monorepo installer, and hub deployment conversion are still in progress.
> Source checkout and installed stack currently have different integration
> guarantees. See [migration status](#migration-status) before installing.

## The stack

| Package                                | Responsibility                     | What lives there                                                                                                                           |
| :------------------------------------- | :--------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| **[suspenders](packages/suspenders/)** | Coordinate the agents              | SQLite work graph, claims and leases, coordination bus, decisions, knowledge, hook gates, dispatch, merge ladder, fleet board, hub tooling |
| **[buckle](packages/buckle/)**         | Govern model access                | OpenAI and Anthropic API dialects, provider adapters, routing ladders, retries and cooldowns, scoped keys, usage accounting, federation    |
| **[belt](packages/belt/)**             | Operate the model fleet            | Specialist registry, MLX lifecycle and routing, dashboard, remote discovery, evaluation and benchmark tools                                |
| **[speedy](packages/speedy/)**         | Equip the developer environment    | CLI tools, curated skills, personas, hooks, settings, statusline, installation and harness configuration                                   |
| **[local](packages/local/)**           | Give services a local front        | Caddy registration, Bonjour/mDNS names, loopback defaults, authenticated LAN exposure, service registry and bar dashboard                  |
| **[local-llm](packages/local-llm/)**   | Run the shared inference runtime   | Extracted flat kit: resident-model supervisor, specialist registry, model spawner, Anthropic-wire router, and runtime config templates     |
| **[blam](packages/blam/)**             | Study and reproduce agent failures | CRASH taxonomy, sanitized incident dataset, deterministic benchmark scenarios, labeling tools, and the shared prompt-condense engine       |

The boundaries matter: **suspenders assigns and tracks work; buckle controls LLM
requests; belt operates the model fleet; speedy configures the agent environment.**
`local` supplies service access, while BLAM provides evidence about failure modes
and prompt transformations.

## How it fits together

```mermaid
flowchart TB
  OP["Operator"]
  ENV["speedy<br/>tools · skills · harness settings"]

  subgraph CONTROL["suspenders · coordination"]
    WORK[("Work graph<br/>items · dependencies · claims")]
    BUS["Coord bus<br/>events · decisions · knowledge"]
    DISPATCH["Dispatch + merge ladder<br/>briefs · worktrees · handoffs"]
    BOARD["Fleet board<br/>tasks · lanes · decisions · usage"]
  end

  AGENTS["Agent lanes<br/>Claude Code · Codex · Copilot"]
  GATE["buckle<br/>scoped access · adapters · routing"]
  LOCAL["Local specialist endpoints<br/>MLX swarm"]
  CLOUD["Configured cloud / remote providers"]
  BELT["belt<br/>model lifecycle · dashboard · benchmarks"]

  OP --> BOARD
  ENV -.-> AGENTS
  WORK --> DISPATCH --> AGENTS
  AGENTS --> BUS --> BOARD
  WORK --> BOARD
  AGENTS -->|"when the scoped front is enabled"| GATE
  GATE --> LOCAL
  GATE --> CLOUD
  BELT -.-> LOCAL

  classDef plane fill:#eef2ff,stroke:#6366f1,color:#1e1b4b;
  classDef model fill:#ecfdf5,stroke:#10b981,color:#022c22;
  class WORK,BUS,DISPATCH,BOARD plane;
  class LOCAL,CLOUD,BELT model;
```

This is a responsibility map. Runtime policy chooses the actual route: the
local router and LiteLLM remain part of existing installations, and dispatch
can fall back to belt directly when the buckle front or admin credential is
unavailable.

### From a goal to a commit

1. **Register the work.** The work graph holds the task, dependencies, priority,
   and executor preferences. Larger missions can split into independent items.
2. **Dispatch a lane.** A claim, worktree, brief, and resume context identify
   the work. Where configured, dispatch mints a revocable `bksk_` credential and
   routes through `/w/<sid>` for lane attribution.
3. **Coordinate as it runs.** WebSocket subscriptions carry events and
   consultations. Decisions and durable facts belong in the coordination plane.
4. **Check and integrate.** Hook gates enforce configured quality and edit
   rules; the merge ladder integrates branches. Closure records commit evidence,
   and reclaim verbs recover claims from dead lanes.

The board also exposes orchestration previews and prompt settings. Deterministic
condensing delegates to BLAM's canonical engine; optional model enhancement has
an unavailable-endpoint fallback.

### From one machine to hubs and spokes

```mermaid
flowchart LR
  CFG[("Machine configuration<br/>stack.yaml · one version pin")]
  CTL["hubctl<br/>render · mint · push · up · status"]
  HUB["Hub services<br/>gateway · board · store · model dashboard"]
  PROBE["Independent health sidecars<br/>network probes · confirming re-probe"]
  SPOKE["Spokes<br/>local agents · optional policy pull"]
  FRONT["local / Caddy<br/>service names · access boundary"]

  CFG --> CTL --> HUB
  PROBE -->|"observe over the network"| HUB
  SPOKE <-->|"configured federation"| HUB
  FRONT --> HUB
```

Hub profiles supply ports, binds, origins, transport and secret paths. The
intended deployment unit is one pinned stack, pulled into named volumes.
Health comes from a separate probe process, with consecutive-miss handling and
an active confirmation before declaring a target down.

The current Compose template still pulls three legacy repositories and uses
their old directory layouts. Monorepo deployment conversion is pending; changing
the origin URL alone does not account for the new `packages/` paths.

## Get started

**Requirements depend on the layer.** TypeScript tools use Bun; the root
manifest declares Bun >=1.1. Developer installers and the local service front
target macOS. MLX inference requires Apple Silicon and enough memory for the
chosen model tier. Hub services use Docker Compose; consumers reach model
endpoints over HTTP.

### Explore and test the source

```sh
git clone https://github.com/klh/fleet.git
cd fleet

# Package-local dependencies while unified workspace wiring is pending.
(cd packages/suspenders && bun install --frozen-lockfile)

# Focused checks of shared condensing, board transforms and lane credentials.
bun test packages/blam/test/condense.test.ts packages/suspenders/test/prompt-transform.test.ts packages/suspenders/test/lane-auth.test.ts

# Run the board from the checkout.
bun packages/suspenders/hooks/bin/fleet-board.ts
```

The board defaults to port **7799**. Package READMEs describe individual tools,
but some still contain pre-migration clone URLs and installation paths.

### Inspect the installer before activation

```sh
bash packages/suspenders/install.sh --dry-run
```

The current installer supports `--wire`, `--with-launchd`, `--skip-models`, and
`--no-llm`, with `SUSPENDERS_PREFIX` and `SUSPENDERS_SHIM_BIN` overrides. Its
default path sets up a minimal local swarm and attempts model downloads.

**Clean installation is not yet complete:** the harness copy omits BLAM, so the
installed board's orchestration modules cannot resolve the shared condenser.
Use the source checkout to explore the board until the packaging fix lands.

## Everyday operations

Once installed and wired, PATH shims expose the command surfaces.
Every verb has `--help`.

| Need                               | Command                                                                  |
| :--------------------------------- | :----------------------------------------------------------------------- |
| See claimable work                 | `work ready`                                                             |
| Inspect an item                    | `work show <id>`                                                         |
| Claim and close with evidence      | `work take <id> --as <sid>` / `work done <id> --as <sid> --sha <commit>` |
| Recover dead claims                | `work reclaim all`                                                       |
| See fleet activity                 | `coord fleet`                                                            |
| Subscribe to coordination events   | `coord subscribe --as <sid>`                                             |
| Retrieve a durable lesson          | `coord fact get lesson.<topic>`                                          |
| Dispatch work                      | `dispatch --help`                                                        |
| Render a hub profile's environment | `bun packages/suspenders/deploy/hubctl.ts render <hub>`                  |
| Inspect hub health                 | `bun packages/suspenders/deploy/hubctl.ts status <hub>`                  |

### Runtime configuration

Real hosts, credentials and organization-specific settings live outside the
repository. Committed configuration supplies examples and defaults.

| Location                                  | Purpose                                                     |
| :---------------------------------------- | :---------------------------------------------------------- |
| `~/.config/klh/stack.yaml`                | Hub profiles, deployment settings and the stack version pin |
| `~/.claude/local-llm/belt.env`            | Runtime provider settings and buckle admin credential       |
| `~/.claude/local-llm/hubs.json`           | Hub labels and candidate URLs                               |
| `~/.claude/local-llm/routing-policy.yaml` | Operator-owned routing ladder                               |
| `~/.claude/local-llm/upstreams.yaml`      | Runtime upstream group overrides                            |
| `~/.claude/local-llm/buckle-spoke.env`    | Spoke bootstrap credential                                  |

Keep secret-bearing files mode **0600**. Root keys are generated on the target
device; admin and lane keys are minted through the gateway API, audited and
revocable. Deployment profiles determine ports and exposure; example port
numbers in package docs are not universal settings.

## Engineering principles

- **One stack version.** The machine-level version pin selects the same ref
  across deployed services; release and workspace consolidation remain migration work.
- **One work ledger.** Tasks and claims belong in the work graph; docs explain
  architecture and decisions. Project identity follows the Git common directory.
- **Independent health.** Sidecars observe real network responses outside
  the served process.
- **Config over code.** Machine facts and secrets stay in runtime configuration.
- **Streams by default.** Streaming HTTP/SSE, NDJSON feeds and bounded rings keep
  asynchronous work from becoming unbounded buffers.
- **Quality at the edit boundary.** qlty is the quality surface, Biome owns code
  formatting, and Prettier owns Markdown. TypeScript files have a 1500-line limit.
- **Lit and design tokens.** Native elements first, vendored assets for offline
  use. Legacy board string rendering remains to be migrated to this standard.

## Evidence and benchmarks

[**benchmarks.md**](benchmarks.md) is the consolidated measurement table: model
serving, routing, stack-versus-direct API comparisons, and prompt transforms.
It distinguishes timing results from small-sample quality evidence. Raw belt
measurements live in [benchmarks.jsonl](packages/belt/bench/benchmarks.jsonl).

BLAM complements those measurements with the **CRASH** failure taxonomy:
Concurrency races, Recovery gaps, Alignment drift, State poisoning, and Handoff
failures. Core scenarios use scripted lane stand-ins, so control-plane failure
reproduction can run without model calls. See the
[taxonomy](packages/blam/docs/taxonomy.md) and [benchmark harness](packages/blam/bench/).

## Migration status

| Area                     | State in this checkout                                                                            |
| :----------------------- | :------------------------------------------------------------------------------------------------ |
| Repository consolidation | Seven package directories are present; this is the destination for new changes                    |
| Shared inference package | Shared swarm kit is extracted into `local-llm`; the installer sources it from this package        |
| Workspace                | Root declares `packages/*`; local and speedy lack manifests and there is no root lockfile         |
| Installation             | Package installers remain; clean harness installation has a reproduced BLAM import failure        |
| Hub deployment           | External probe sidecars are present; origins and execution paths still follow legacy repositories |
| CI                       | Workflows are nested under packages; no root GitHub Actions workflow is present                   |
| Private tier             | `fleet-remote` is the planned separate enterprise monorepo, outside this checkout                 |

The work graph carries migration work, including the landed extraction (W422.4),
workspace wiring (W422.5), clean installation (W422.6), and deployment conversion
(W422.7). Consult the live graph for item status.

## Read further

- [Monorepo review](docs/monorepo-review-2026-10-05.md) — verified integration findings and validation limits.
- [Control plane](packages/suspenders/README.md) — work, coordination, dispatch and board surfaces.
- [Gateway](packages/buckle/README.md) — adapters, routing and governance.
- [Model fleet](packages/belt/README.md) — model roles, lifecycle and evaluation.
- [Developer environment](packages/speedy/README.md) and [local services](packages/local/README.md).
- [Hub deployment](packages/suspenders/deploy/README.md) and [example configuration](packages/suspenders/deploy/stack.example.yaml).
- [Local-LLM runtime](packages/local-llm/README.md) — kit layout, operation and provenance.

## Licensing

Licenses are package-specific. Buckle, speedy and BLAM code carry MIT licenses;
suspenders, belt and local carry Business Source License 1.1 files with
package-specific parameters. BLAM's dataset has a separate CC-BY-4.0 notice.
`local-llm` does not yet have its own license file. Consult each package's
`LICENSE` and applicable notices rather than assuming one license for the stack.

---

<div align="center">

A [Threads](https://www.threads.dk) thing.

</div>
