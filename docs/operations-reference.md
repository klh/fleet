# Operations reference

The deep operations detail behind the root AGENTS.md Operations index:
hub deploys, board API, buckle key endpoints, the launchd label map, the
port map, machine-level config paths, and the IKEA Copilot seat. Load at
need — lanes never need all of this per session. Single-source rule: this
file is the only place this material lives; AGENTS.md points here.

## Hubs — `bun deploy/hubctl.ts <verb> <hub>`

Config-over-code deploys from `~/.config/klh/stack.yaml` (hub = a profile:
ports, binds, ssh/dir/docker, secret PATHS):

- `render <hub>` — the compose .env (no secrets)
- `mint <hub>` — root key generated ON the hub (0600, idempotent)
- `push <hub>` — template + .env streamed (scp -O; Synology has no SFTP)
- `up <hub>` — docker compose up -d · `status <hub>` — health probes
- `deploy <hub>` — install-grade one-shot: mint → push → up → status
  (alias: `bash install.sh --hub <name>` from packages/suspenders;
  `--dry-run` renders the .env only)
- live profiles: `nas` (kk@nas.threads.dk) and `desktop` (local Docker)

## Board — `bun packages/suspenders/hooks/bin/fleet-board.ts` (:7799)

- `POST /api/prompt/settings` — the prompt.condense/enhance/debug/log
  toggles (GET reads); `POST /api/orchestrate/preview
  {"project": "<repo path>", "goal": "..."}` — what WILL be dispatched
  (condense + enhance run for real; previewId held; nothing written)
- writes need `x-klh-write-token: $(cat
  ~/.cache/claude-governor/write-token)`; W264 host guard: only `*.local`
  + loopback Hosts pass

## Buckle gate (LLM auth — keys are the front door)

- root key: hubs = `<repo>/buckle/buckle.env` (compose env_file), Mac
  spoke = `~/.claude/local-llm/buckle-spoke.env`
- admin: `belt.env BUCKLE_ADMIN_KEY` (scopes admin+proxy WRITE)
- `POST /v1/admin/keys {"name","scopes"}` mint · `GET /v1/admin/keys` ·
  `POST /v1/admin/keys/verify` · `POST /v1/admin/keys/<id>/revoke`
- per-lane keys: name=sid, scope `buckle:proxy:WRITE_`; test keys get
  revoked, never left behind

## launchd labels (port/process map)

`launchctl kickstart gui/$(id -u)/<label>` revives a label.

- `com.suspenders.belt-swarm` — the belt kit's `supervise` supervisor
  (KeepAlive; renamed from com.belt.swarm for the W640 receipt namespace):
  spawns :4000 + the MLX specialists (W284: the ONLY swarm supervisor —
  `com.suspenders.local-llm` is retired and rides the LEGACY boot-out list)
- `com.suspenders.cloud-gateway` — cloud transport lifecycle
  (belt/bin/cloud-gateway.ts → litellm :4100); never starts router/swarm
- W779 heartbeat (2026-10-18): the no-port maintenance agents (fleet-
  monitor, db-backup, harvest, quota-sweep, dispatch-watchdog, llm-
  keepwarm, coord-worker, auto-install, soak, rogue-reap W827, license-
  audit W828, metrics-alert W782.2.1, knowledge-sync W944 — reaps lane-
  leaked serve processes in stale .worktrees dirs + prunes merged-and-clean
  worktrees; `.fleet/rogue-reap-paused` pauses) are NOT launchd units —
  they are typed tasks fired by the ONE fleet-loop cycle, each task owning
  its cadence and fan-out (hooks/lib/fleet-loop/maintenance.ts; retired
  labels ride the services.yaml legacyLabels boot-out list)
- `com.belt.dashboard` — fleet dashboard :7791 (LAN: belt.local:7791),
  runtime copy ~/.claude/local-llm/dashboard.ts
- `com.suspenders.buckle-spoke` — buckle gateway :4101 (Mac spoke)
- `com.suspenders.board` — fleet board :7799
- `com.suspenders.fleet-pulse` — W822 periodic digest (StartInterval =
  notify.yaml pulse.interval_s, default 14400): `notify.ts pulse` composes
  lanes/READY/DONE/watchdog/decisions/commits into one notification via the
  notify.yaml 'pulse' class; every install registers it post-install
- `com.klh-local.caddy` — the Caddy .local front
- same namespace, no ports: knowledge-worker
- LEGACY, never load: `com.klh.local-llm` / `com.klh.llm-keepwarm` /
  `com.klh.fleet-monitor` (superseded — installers boot them out and rm the
  plists) and `com.belt.gateway` (retired W277 — was the :4100 litellm
  wrapper; a plist may linger on disk but must stay UNLOADED) and
  `com.suspenders.local-llm` (retired W284 — the suspenders local-llm serve
  fork; both installers boot it out and rm the plist)

## Ports and processes

- local-llm swarm: `bun ~/.claude/local-llm/swarm.ts status|supervise` —
  belt kit is the source (W284: the suspenders local-llm serve fork is
  retired; installs heal the runtime home's belt closure from
  packages/belt/bin). Specialists (belt registry.ts): :8901 coder · :8902
  extract · :8903 reason · :8906 danish/general · :8907 embeddings · :8912
  kev · :8913 rerank — the tier manifest `tier.json` scopes the RESIDENT
  set (BELT_TIER=minimal = :8902 + :8913; the rest load on demand). :4000 =
  belt/bin/router-shim.ts — the Anthropic-format API (complexity-v3 router)
  that is the seam lanes ride; `supervise` spawns it from the runtime-home
  copy
- belt router :4000 (= router-shim, see above) · litellm :4100
  (com.suspenders.cloud-gateway) · buckle spoke :4101 (Mac), hubs :4101
  (NAS) / :4111 (desktop) · board :7799 · store :7794 (Mac) / :7795 (NAS) /
  :7796 (desktop)
- NAS = `kk@nas.threads.dk`; docker at `/usr/local/bin/docker` (NOT on
  non-interactive PATH); compose v5.6.0 per-user plugin

## Machine-level config (the SOLE conf — repos carry placeholders only)

- `~/.config/klh/stack.yaml` (mode 600): hub profiles + `version:` — the
  one string that pins buckle+suspenders+belt
- `~/.claude/local-llm/`: `belt.env` (upstream keys, BUCKLE_ADMIN_KEY),
  `hubs.json` (label → candidate URLs resolveHub walks),
  `routing-policy.yaml` (operator-owned ladder — edit THIS, never code),
  `upstreams.yaml` (group overrides — per-model upstream ladders over
  swarm :8902 / router :4000 / litellm :4100), `buckle-spoke.env` /
  `buckle-desktop.env` (BUCKLE_ROOT_KEY; the spoke env also holds
  `GITHUB_COPILOT_PAT`, resolved from the 0600 `copilot.key`)
- IKEA Copilot seat (W695.6): claude-* lane models are first-class buckle
  upstreams — `https://api.githubcopilot.com` serves the Anthropic wire
  (`/v1/messages`, Bearer `GITHUB_COPILOT_PAT`, header
  `copilot-integration-id` via `adapter_config.headers`; tools+SSE on this
  wire unverified 2026-10-12, quota wall same day); group `claude-sonnet-5`
  → `model: claude-sonnet-5.5` (dots-to-dashes alias is data). Template:
  `packages/buckle/upstreams.copilot.yaml` → merge into the machine
  `upstreams.yaml`. The `:4102` ikea-shim is RETIRED (never activated);
  litellm copilot rows stay off (its /v1/messages bridge hits the Responses
  API Copilot rejects; its provider forces an interactive device flow)

## Install

- `bash install.sh [--wire] [--with-launchd]` from fleet/packages/suspenders
  — the ONLY repo→prefix sync (SUSPENDERS_PREFIX / SUSPENDERS_SHIM_BIN
  override); old checkouts are push-dead (archived)
