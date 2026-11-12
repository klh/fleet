# W3023 — ZAI provider topology audit (read-only receipt)

Audit lane, 2026-11-12. Scope was narrowed mid-item by root (coord notes
#125561, #125565): the config-fix mandate was withdrawn in favour of W3025,
which owns the real ZAI→Muramasa consolidation. This file is the audit
receipt; the applied-then-reverted changes are recorded in §6.

## 1. The pairing gate — why no hub paired to ZAI

`packages/belt/bin/dashboard-topology-model.js:677-683` pairs a provider to a
hub iff `hub.providerKeys?.includes(key) || hub.providerIntents?.includes(key)`
(the UI mirror is `dashboard-topology.js:671`). Both inputs failed for ZAI:

- `providerKeys` is minted only from **cloud** upstream hosts —
  `configuredProviders` (model js:411-416) keeps a host only when
  `providerKey(host) !== host`, so the `127.0.0.1` legs that actually carry
  the GLM groups can never mint a provider key (`providerKey` maps
  `*.z.ai → zai`, raw IPs fall through to themselves).
- `providerIntents` for the desktop hub was
  `[anthropic, openai, openrouter, chatgpt]` — no `zai`.

Consequence: the desktop hub routes `zai-glm-5.3-flash` but declared no ZAI
intent and had no cloud ZAI host, so the graph drew no hub→ZAI edge. The ZAI
provider card itself still rendered (`up`), seeded from the probe inventory.

## 2. The orphan `zai` hubRoutes row — persistence source

Not a belt store row, not a cache. Two files, joined by label:

- `~/.claude/local-llm/hubs.json` — key `zai` with a candidate URL. `readHubs()`
  (`packages/belt/bin/hubs.ts:86-129`) turns every key with a usable URL into a
  row, and `hubGatewayRoutes()` (same file, :180-...) joins it to the
  `settings.json` profile of the same label to produce the 13-route payload
  `/api/topology-context` renders.
- `~/.config/klh/settings.json` — `hubs.zai`, whose `upstreams.groups` supply
  those 13 routes.

The row is "orphan" on the board because the **supervisor skips it**:
`packages/belt/bin/supervisor.ts:1056-1065` keys the status map by PORT and
skips a registry hub whose port is already taken by a local row. The registry
URL for `zai` is the port the Mac buckle spoke already owns, so `zai` never
becomes a supervised target — while `hubGatewayRoutes()` has no such dedupe and
keeps emitting the row. That asymmetry (port-dedupe on targets, none on routes)
is the actual defect behind the row.

## 3. The registry alias is stale, the hub profile is not

Identity probes (`/api/health`, 401 bodies name their own origin):

| port | `origin=` in the 401 body | what it really is |
| ---- | ------------------------- | ----------------- |
| spoke port | `local` | the Mac buckle spoke |
| desktop port | `desktop` | Muramasa hub |
| copilot hub port | `<copilot hub>` | the copilot hub |
| `4301` | `zai` | the ZAI hub container |

So the `hubs.json` `zai` candidate points at the **spoke**, not at the ZAI hub.
It is a stale alias. The ZAI hub itself is **live and real**, not orphaned:
compose project `klh-hub-zai`, config file `~/.config/klh/hub-zai/hub-compose.yaml`,
full sidecar set running (`zai-buckle-hub`, `-belt-hub`, `-board-hub`,
`-store-hub`, `-model-store-hub`, mdns announce + the `*-health` probes). The
empty `Ports` column in `docker ps` is host networking, not a missing publish:
the health sidecar answers and reports `{label: zai, port: 4301, ok: true}`.

`resolveHub("zai")` returns `url=http://127.0.0.1:4301, via="settings hubs"` —
dispatch resolves the label from the **settings profile**, which wins at stage
2b of `hub-locate.ts`; the `hubs.json` registry is only the stage-3 fallback.

## 4. Serving-route identity for the GLM legs

`~/.claude/local-llm/upstreams.json` group `glm-5.3-flash` (4 legs, in order):

| prio | url | dialect/adapter | model | `api_key_env` | state |
| ---- | --- | --------------- | ----- | ------------- | ----- |
| 0 | `127.0.0.1:4301` | anthropic | `glm-5.3-flash` | `ZAI_HUB_KEY` | serving |
| 0 | `127.0.0.1:4301` | openai/zai | `glm-5.3-flash` | `ZAI_HUB_KEY` | serving |
| 1 | `127.0.0.1:4100` | anthropic | `glm-5.3-flash` | `LITELLM_KEY` | **down** |
| 1 | `127.0.0.1:4100` | openai | `zai-glm-5.3-flash` | `LITELLM_KEY` | **down** |

`zai-glm-5.3`, `zai-glm-5.2`, `glm-5.3`, `glm-5.2`, `*-flashx` follow the same
`:4301` → `:4100` shape. The key indirection matters: the `:4301` legs ride
`ZAI_HUB_KEY` (the hub's own service key), **not** the registry token — the
registry token authenticates against the spoke and is refused by `:4301`
(`zai.buckle.invalid_key`).

Observed serving identity, from the ledger route rows: requested
`glm-5.3-flash` → `target_kind=local, 127.0.0.1:4301, status 200`. The
throughput interface agrees (`req15=68`, fresh `lastOkAt`). **The ZAI hub
container is the serving route for GLM today.**

The **desktop** hub's own profile points its `general` / `glm-5.3-flash` groups
at `127.0.0.1:4100` (`zai-glm-5.3-flash`, `LITELLM_KEY`) — and the litellm
process is not listening (`com.suspenders.cloud-gateway` is loaded with exit
status 1, port refuses). So the desktop hub's configured ZAI leg is currently
dead; it would pair as `configured`, never `observed`, until W3025 repoints it.

## 5. GLM error accounting

### 5a. 24h outcomes, from the buckle observation sink (`lane.request.ended`)

11 872 ended events in 24h. GLM/ZAI rows:

| requested model | outcome | status | n |
| --------------- | ------- | ------ | - |
| glm-5.3-flash | policy | 200 | 9644 |
| glm-5.3-flash | errored | 502 | 553 |
| zai-glm-5.3-flash | policy | 200 | 328 |
| glm-5.3-flash | errored | 503 | 283 |
| glm-5.3-flash | errored | 499 | 124 |
| glm-5.3 | errored | 502 | 113 |
| glm-5.3-flash | errored | 200 | 50 |
| glm-5.3-flash | fallback | 200 | 26 |
| glm-5.2 | errored | 502 | 25 |
| zai-glm-5.3-flash | errored | 200/499/503/502 | 24/16/15/9 |

All GLM rows carry `origin=local` — they enter at the spoke. The relay rows
show the ZAI hub carrying the traffic (`14 532` requests / `809` errors,
`active=2`, freshness 15 s), so hub-side errors are real, not a rendering
artefact.

### 5b. The dashboard's "11 GLM errors + 5 unattributed"

Those come from the rolling **15-minute** `audit15` block, not from 24h. The
snapshot taken during this audit:

```
attempts 373 · succeeded 115 · failed 251 · unsettled 7 · unattributedFailed 232
failures: {kind:null, host:null}            ×232
          {local, 127.0.0.1:4301}           ×12
          {local, 127.0.0.1:4000}           ×5
          {cloud, <copilot host>:443}       ×2
```

- the "GLM errors" bucket = failures on the `:4301` leg — the ZAI hub leg;
- the "5 unattributed" = failures against `:4000` (the router shim). They are
  unattributed **by construction**: `providerKey("127.0.0.1")` returns the raw
  host, and only `mapped !== raw` hosts become a provider, so every local-port
  failure lands in the null-host bucket. The same rule hides the much larger
  `×232` null bucket behind the one-line "no target attribution" note.

### 5c. Fallback amplification

`~/.claude/local-llm/routing-policy.json` `gateway.fallbacks`:

```
claude-sonnet-5  → glm-5.3-flash
claude-opus-5-5  → glm-5.3
glm-5.3-flash    → zai-glm-5.3-flash
glm-5.3 / glm-5.2 → zai-glm-5.* , local-swarm
```

plus `context_window_fallbacks` sending all five `local-*` / nas groups to
`glm-5.3-flash`. Requested-vs-served therefore diverges routinely: a
`claude-sonnet-5` request that falls back is **ledgered as `glm-5.3-flash`**,
which inflates both the GLM volume and the GLM error count with failures that
began as another model's request.

### 5d. Why the dashboard says "Buckle ledger unavailable"

`packages/belt/bin/dashboard.ts:750-760` fetches the board's
`/api/console/network` with a **2500 ms** abort. Measured latencies for that
endpoint during this audit: 6739 ms, 5642 ms, 5386 ms, 2468 ms, then >20 s and
>60 s. The belt budget is below the feed's typical response time, so
`/api/network` returns `{ok:false, reason:"Board network feed unavailable"}`
almost always — which is why hub→provider edges render `configured` with
`source:"Buckle ledger unavailable"` and why failures show up unattributed even
when the ledger holds the attribution. This is a repo-level defect independent
of ZAI; it is not fixed here (read-only scope).

## 6. Changes applied before the scope correction — all reverted

Two machine-conf edits were applied under the original mandate, then reverted
byte-exact when root withdrew it (#125561) and the W3025 lane asked for
preservation (#125565):

1. `settings.json` `hubs.desktop.provider_intents` += `zai` — **reverted**.
   While applied it produced exactly the asked-for edge, live, with no restart:
   `{from:"hub:desktop", target:"provider:zai", evidence:"configured",
   source:"Muramasa Hub configured upstream"}`, rendering ZAI alongside the
   other four desktop providers. It is a *declaration*, not a migration: the
   edge stays `configured` (dashed) until the desktop hub actually serves ZAI.
2. `hubs.json` key `zai` removed — **reverted**. While applied, the orphan
   `zai` hubRoutes row disappeared from `/api/topology-context` immediately and
   `resolveHub("zai")` still returned the ZAI hub (settings profile wins), so
   dispatch was unaffected.

Both files were restored from 0600 backups and verified byte-identical to their
pre-audit content; the backups were then removed. Live `/api/topology-context`
is back to the baseline four rows (`zai` 13 routes, desktop intents without
`zai`). No container, launchd unit, or service was touched or restarted at any
point.

## 7. Handover to W3025

- The one-line intent append is proven to work and is reversible — but per root
  it must follow, not precede, a real desktop-served ZAI route.
- The desktop hub's ZAI leg targets a litellm port that is not listening; that
  is the gap to close before the edge can ever read `observed`.
- `hubProviderObservations` only upgrades an edge when the hub's ledger rows
  resolve to a provider, which requires either a cloud host on the leg or a
  single-intent hub — a desktop leg pointed at a loopback port will stay
  `configured` even once it serves. Worth deciding deliberately in W3025.
- The `zai` registry alias and the hub profile disagree (spoke port vs 4301).
  Nothing reads the alias on the dispatch path; belt is its only consumer.
