# fleet — the klh agent stack

One monorepo, one version, every service. The agent-fleet control plane:
governor work graph, coord bus, LLM gateway with per-lane credentials and
scoped keys, the local MLX swarm, and the hub deployment topology — all
versioned as ONE stack (`v2.0.0` tags ride every release of the whole).

## Packages

| package               | what it is                                                               |
| --------------------- | ------------------------------------------------------------------------ |
| `packages/suspenders` | the control plane: governor.db, coord bus, hooks/gates, dispatch, deploy |
| `packages/buckle`     | the LLM gateway: governance gate, scoped keys, routing, federation       |
| `packages/belt`       | the LLM fleet dashboard + gateway                                        |
| `packages/speedy`     | the config layer                                                         |
| `packages/local`      | the Caddy `.local` service front                                         |
| `packages/local-llm`  | the local MLX swarm kit (extraction pending — W422.4)                    |

The private `fleet-remote` monorepo (the paid enterprise tier) mirrors this
structure and DEPENDS on these packages — never copies.

## The stack, as deployed

```mermaid
graph TB
  subgraph lanes["Agent lanes — claude / codex / copilot"]
    L1["lane autowN"]
    L2["lane autowM"]
  end

  subgraph spoke["Local spoke (this machine)"]
    BF["buckle :4101 — governance gate<br/>per-lane bksk_ keys, /w/&lt;sid&gt; attribution"]
    SHIM["anthropic-shim :4000<br/>(Anthropic↔OpenAI seam)"]
    SWARM["local-llm swarm :890x<br/>MLX residents"]
  end

  subgraph control["Control plane (packages/suspenders)"]
    GOV["governor.db<br/>the work graph"]
    COORD["coord bus — WS push"]
    BOARD["fleet board :7799"]
    LOOP["fleet-loop + dispatch"]
  end

  subgraph hub["Hubs — NAS / desktop (deploy/hub-compose.yaml)"]
    RS["repo sidecars<br/>git-pulled @ stack version"]
    BR["buckle-hub"]
    BH["board-hub"]
    SH["store-hub"]
    BTH["belt-hub"]
    HS["health sidecars<br/>status.json heartbeat, outside-process verdict"]
  end

  HUBCTL["hubctl — ONE version string in<br/>~/.config/klh/stack.yaml deploys it all"]
  ROOT["root install.sh<br/>(one installer, every machine)"]

  LOOP --> L1
  L1 -->|"keyed /w/&lt;sid&gt;"| BF
  BF --> SHIM --> SWARM
  BF -.->|"cloud rows (env-gated keys)"| CLOUD["z.ai / anthropic"]
  GOV --- COORD --- BOARD
  HUBCTL --> RS
  RS --> BR & BH & SH & BTH
  HS -.->|"watches"| BR & BH & SH & BTH
  ROOT --> control
```

## Laws the stack runs on

- **One version**: `version:` in the machine-level stack config pins buckle +
  suspenders + belt; hubctl renders it as the git ref every hub pulls.
- **Config-over-code**: real hosts, keys, OIDC values live ONLY in
  machine-level runtime config (`~/.config/klh/stack.yaml`, `~/.claude/local-llm/*.env`,
  mode 600) — repos carry placeholders.
- **Health is outside-process**: a server cannot paint itself healthy. Every
  service regenerates a `status.json` heartbeat (ts, pid, uptime, memory,
  event-loop lag) from its own event loop; a health sidecar judges by file
  age, degrades on misses, and actively probes before calling it unhealthy.
- **Secrets are minted, never typed**: root keys generated ON the target
  device (0600, idempotent), admin and per-lane `bksk_` keys minted via the
  gate's admin API, revocable, audited.
- **No host-path deploys**: hub containers mount git-pulled volumes, never
  dev checkouts.
- **Streams over buffers; one ledger (governor.db); 1500-line hard limit;
  Lit components; qlty/biome gates.**

## Status

The monorepo merge is in flight: history-preserving subtree merges are in,
the unified installer and workspace wiring (W422.4–.6) land next, then the
original repositories archive with pointers here.
