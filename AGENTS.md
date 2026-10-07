# fleet — the klh agent stack

One monorepo, one version, every service. packages/: suspenders (control
plane), buckle (LLM gateway), belt (dashboard/gateway), speedy (config
layer), local (Caddy front), local-llm (MLX swarm kit), blam (agent-mishap
benchmark). The private enterprise tier = fleet-remote (mirrors packages/,
depends on fleet) — pending W422.9.

## Laws (project-wide, every package)

- **One version**: `version:` in `~/.config/klh/stack.yaml` pins buckle +
  suspenders + belt; hubctl renders it as the git ref every hub pulls.
- **Config-over-code**: real hosts, keys, OIDC values live ONLY in
  machine-level runtime config (`~/.config/klh/stack.yaml`,
  `~/.claude/local-llm/*.env`, mode 600) — repos carry placeholders only.
- **Health is outside-process** (owner law 2026-10-05): a server cannot
  paint itself healthy. Every hub service gets a `*-health` probe sidecar
  (deploy/healthcheck/probe.ts) that polls the real target over the
  network, serves the verdict on its own port, degrades on consecutive
  misses, and actively re-probes before flipping to down; compose health
  hits the SIDECAR, never the served process.
- **Secrets are minted, never typed**: root keys generated ON the target
  device (0600, idempotent, never printed); admin + per-lane `bksk_` keys
  minted via the gate's admin API; revocable, audited.
- **No host-path deploys**: hub containers mount git-pulled volumes.
- **qlty is THE quality tool**; `.qlty/` must exist or the on-write gate
  silently no-ops. SPEC FIRST: read `.qlty/qlty.toml` + the biome rule set
  before the first write; never emit flagged patterns. biome owns code
  formatting; prettier owns markdown only.
- **1500-line hard limit** on any .ts — decompose, DRY the second
  duplicate, ast-grep for shareable patterns before adding near the limit.
  The on-write gate blocks past 1500.
- **UI engineering law**: Lit web components + CSS design tokens. NEVER
  `innerHTML`, never `document.write`. Native elements before custom.
  Lit is vendored (offline LAN — never CDN).
- **Streams over buffers**: streaming interfaces by default; NDJSON for
  logs/feeds; bounded rings with backpressure for async writes.
- **Old repos are push-dead**: all 9 originals (suspenders, belt, buckle,
  local, speedy, blam + the 3 -remotes) are ARCHIVED with redirect stubs.
  Every commit lands in THIS repo at `packages/<name>/*`. The old local
  checkouts still WORK for the installed harness (shims point there) until
  W422.6 re-anchors the install to fleet.

## Working agreements

- Work graph: `work` CLI (project identity = the repo's git-common-dir —
  fleet sessions get their own identity; the historical graph lives under
  the suspenders identity until the rekey lands, W428).
- Coordination plane: coord CLI + WS subscribe; broadcast landed changes
  that affect lanes (what/who/exact command).
- Per-package AGENTS.md files are each subtree's canonical docs — they are
  the package-level truth; this root file is the stack-wide law.

## Operations — every verb and what it is for

Shims on PATH (`coord`, `work`, `dispatch` → the installed prefix;
`~/.local/bin`, override with SUSPENDERS_SHIM_BIN). Every verb has
`--help` (per-verb usage + flags from its schema).

Work graph (`work` — the ONE ledger; never Markdown todos):

- `work ready` — claimable items · `work list` — all (◐ claimed, ⊞ split)
- `work show <id>` — the item · `work take <id> --as <sid>`
- `work done <id> --sha <sha>` — close with evidence
- `work add <title> [--parent <id>] [--priority n] [--desc ...]` — mint
  (never invent work; empty title = unfilled item)
- `work split` — fan out parallelizable work · `work lanes [--json]` —
  lane liveness (the one liveness surface)
- `work reclaim all` — dead lanes' claims → READY (ghost cleanup)

Coordination (`coord`):

- `coord subscribe --as <sid>` — WS push inbox; opened at session start;
  NEVER poll with repeated probes
- `coord emit BROADCAST --scope suspenders --as <sid> --note "..."` —
  every lane-affecting landed change broadcasts same-turn
- `coord emit NEED_DECISION --to <sid> --note "q + options" --as <sid>` —
  a decision held only in your head is invisible; emit it
- `coord fact set/get/list` — fleet knowledge (`lesson.*` before
  re-deriving pain; `finding.*` for intel; IKEA content ONLY here)
- `coord consult` / `coord who-knows` — questions, never ownership
- `coord fleet` — who is working (sessions + claims; never /tmp files)
- `coord project identity` / `coord project rekey <old> <new>` — graph
  identity migration as a VERB (W428): one tx across work_items, work_deps,
  work_sequences, consults, consult_kb, sessions + events `$.project`;
  children-first + `PRAGMA defer_foreign_keys` (composite FKs on
  work_deps→work_items 500 otherwise); refused when the target holds items

Lanes (`dispatch`) — spawns a headless lane from READY work: brief
composed (caveman-condensed), per-lane `bksk_` key minted from
`belt.env BUCKLE_ADMIN_KEY`, rides the buckle front `/w/<sid>`, 0600
per-lane `--settings` file. No admin key = belt direct, surfaced.

Hubs (`bun deploy/hubctl.ts <verb> <hub>`) — config-over-code deploys from
`~/.config/klh/stack.yaml` (hub = a profile: ports, binds, ssh/dir/docker,
secret PATHS):

- `render <hub>` — the compose .env (no secrets)
- `mint <hub>` — root key generated ON the hub (0600, idempotent)
- `push <hub>` — template + .env streamed (scp -O; Synology has no SFTP)
- `up <hub>` — docker compose up -d · `status <hub>` — health probes
- `deploy <hub>` — install-grade one-shot: mint → push → up → status
  (alias: `bash install.sh --hub <name>` from packages/suspenders;
  `--dry-run` renders the .env only)
- live profiles: `nas` (kk@nas.threads.dk) and `desktop` (local Docker)

Board (`bun packages/suspenders/hooks/bin/fleet-board.ts` — :7799):

- `POST /api/prompt/settings` — the prompt.condense/enhance/debug/log
  toggles (GET reads); `POST /api/orchestrate/preview
{"project": "<repo path>", "goal": "..."}` — what WILL be dispatched
  (condense + enhance run for real; previewId held; nothing written)
- writes need `x-klh-write-token: $(cat
~/.cache/claude-governor/write-token)`; W264 host guard: only `*.local`
  - loopback Hosts pass

Buckle gate (LLM auth — keys are the front door):

- root key: hubs = `<repo>/buckle/buckle.env` (compose env_file), Mac
  spoke = `~/.claude/local-llm/buckle-spoke.env`
- admin: `belt.env BUCKLE_ADMIN_KEY` (scopes admin+proxy WRITE)
- `POST /v1/admin/keys {"name","scopes"}` mint · `GET /v1/admin/keys` ·
  `POST /v1/admin/keys/verify` · `POST /v1/admin/keys/<id>/revoke`
- per-lane keys: name=sid, scope `buckle:proxy:WRITE_`; test keys get
  revoked, never left behind

Machines and processes:

- install: `bash install.sh [--wire] [--with-launchd]` from
  fleet/packages/suspenders — the ONLY repo→prefix sync (SUSPENDERS_PREFIX /
  SUSPENDERS_SHIM_BIN override); old checkouts are push-dead (archived)
- launchd labels (port/process map; `launchctl kickstart
  gui/$(id -u)/<label>` revives):
  - `com.suspenders.local-llm` — the swarm kit's `serve` supervisor
    (KeepAlive): spawns :4000 + the MLX specialists below
  - `com.suspenders.cloud-gateway` — cloud transport lifecycle
    (belt/bin/cloud-gateway.ts → litellm :4100); never starts
    router/swarm
  - `com.suspenders.llm-keepwarm` — llm-keepwarm.ts every 240s, no port
  - `com.belt.dashboard` — fleet dashboard :7791 (LAN:
    belt.local:7791), runtime copy ~/.claude/local-llm/dashboard.ts
  - `com.suspenders.buckle-spoke` — buckle gateway :4101 (Mac spoke)
  - `com.suspenders.board` — fleet board :7799
  - `com.klh-local.caddy` — the Caddy .local front
  - same namespace, no ports: fleet-monitor, knowledge-worker, db-backup
  - LEGACY, never load: `com.klh.local-llm` / `com.klh.llm-keepwarm` /
    `com.klh.fleet-monitor` (superseded — installers boot them out and
    rm the plists) and `com.belt.gateway` (retired W277 — was the :4100
    litellm wrapper; a plist may linger on disk but must stay UNLOADED)
- local-llm swarm: `bun ~/.claude/local-llm/swarm.ts status|serve` —
  dual home since W422.4: source = packages/local-llm (the kit) with the
  belt bin/* overlay, runtime home = ~/.claude/local-llm (W556: the
  runtime swarm.ts is its own source of truth — install refuses to
  clobber it). Specialists (belt registry.ts): :8901 coder · :8902
  extract · :8903 reason · :8906 danish/general · :8907 embeddings ·
  :8912 kev · :8913 rerank — the tier manifest `tier.json` scopes the
  RESIDENT set (BELT_TIER=minimal = :8902 + :8913; the rest load on
  demand). :4000 = belt/bin/router-shim.ts — the Anthropic-format API
  (complexity-v3 router) that is the seam lanes ride; `serve` spawns it
  from the runtime-home copy
- belt router :4000 (= router-shim, see above) · litellm :4100
  (com.suspenders.cloud-gateway) · buckle spoke :4101 (Mac), hubs
  :4101 (NAS) / :4111 (desktop) · board :7799 · store :7795 (NAS) / :7796
- NAS = `kk@nas.threads.dk`; docker at `/usr/local/bin/docker` (NOT on
  non-interactive PATH); compose v5.6.0 per-user plugin

Machine-level config (the SOLE conf — repos carry placeholders only):

- `~/.config/klh/stack.yaml` (mode 600): hub profiles + `version:` — the
  one string that pins buckle+suspenders+belt
- `~/.claude/local-llm/`: `belt.env` (upstream keys, BUCKLE_ADMIN_KEY),
  `hubs.json` (label → candidate URLs resolveHub walks),
  `routing-policy.yaml` (operator-owned ladder — edit THIS, never code),
  `upstreams.yaml` (group overrides — per-model upstream ladders over
  swarm :8902 / router :4000 / litellm :4100),
  `buckle-spoke.env` / `buckle-desktop.env` (BUCKLE_ROOT_KEY)
