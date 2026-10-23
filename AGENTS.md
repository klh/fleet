# fleet — the klh agent stack

One monorepo, one version, every service. packages/: suspenders (control
plane), buckle (LLM gateway), belt (dashboard/gateway), speedy (config
layer), local (Caddy front), local-llm (MLX swarm kit), blam (agent-mishap
benchmark). The private enterprise tier = klh-remote (mirrors packages/,
depends on fleet; local-only until its GitHub push — W422.9/W422.1).

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
- **Scrub gate (W236)**: git commit/push runs staged/unpushed ADDED lines
  through the scrub rule set (hooks/lib/scrub.ts): `/Users/<user>` paths,
  local-denylist hosts/IPs/MACs (`~/.claude/local-llm/scrub-denylist`, mode
  600, machine-local, never committed), key material (sk-/AKIA/ghp_/PEM/
  slack), IKEA-internal markers. Denies with file:line + redacted match; <!-- scrub:allow -->
  the only escape is the explicit `scrub:allow` marker on the offending
  line. `SUSPENDERS_SCRUB=0` disables; repo-level enforcement via
  `git config core.hooksPath .githooks` (committed .githooks stubs).
- **No host-path deploys**: hub containers mount git-pulled volumes.
- **qlty is THE quality tool**; `.qlty/` must exist or the on-write gate
  silently no-ops. SPEC FIRST: read `.qlty/qlty.toml` + the biome rule set
  before the first write; never emit flagged patterns. biome owns code
  formatting; prettier owns markdown only.
- **1500-line hard limit** on any .ts — decompose, DRY the second
  duplicate, ast-grep for shareable patterns before adding near the limit.
  The on-write gate blocks past 1500; CI gates every commit
  (tests/law-guards.test.ts).
- **Shell scripts are banned** — TypeScript on Bun is the automation
  surface (LaunchAgent→bun entry points, one-line aliases only). The
  tracked .sh set is the pinned legacy exception, guarded by
  tests/law-guards.test.ts; a new .sh needs an explicit allowlist entry
  arguing why bun won't do.
- **UI engineering law**: Lit web components + CSS design tokens. NEVER
  `innerHTML`, never `document.write`. Native elements before custom.
  Lit is vendored (offline LAN — never CDN).
- **Streams over buffers**: streaming interfaces by default; NDJSON for
  logs/feeds; bounded rings with backpressure for async writes.
- **Old repos are push-dead**: all 9 originals (suspenders, belt, buckle,
  local, speedy, blam + the 3 -remotes) are ARCHIVED with redirect stubs
  (verified 2026-10-07 via gh). Every commit lands in THIS repo at
  `packages/<name>/*`; install.sh syncs the prefix from fleet
  (W422.4/W422.6 re-anchor landed).

## Working agreements

- Work graph: `work` CLI (project identity = the repo's git-common-dir —
  fleet sessions get their own identity; the historical graph lives under
  the suspenders identity until the rekey lands, W428).
- Coordination plane: coord CLI + WS subscribe; broadcast landed changes
  that affect lanes (what/who/exact command).
- Per-package AGENTS.md files are each subtree's canonical docs — they are
  the package-level truth; this root file is the stack-wide law.

## Supervisor reporting (W892, installed face W899/W906)

`work report` (verb) — with `bun ~/.claude/hooks/suspenders/bin/fleet-report.ts`
as its installed-face shim (argv-verbatim passthrough, W913) — renders THE
supervisor reply table (owner GO 2026-10-19): rows = riding + queued +
last-5-done (or strict `--ids w1,w2`); columns ITEM/ST/TASK/TOKENS/CACHE/
OUT-MIN/AGENT from each item's W776 attribution; fixed-width programmatic
pads; ST letters R = riding, Q = queued, D = done, F = failed (W891 colors
them on the board). Supervisor ticks paste it verbatim — the session-start
SUPERVISOR DEFAULT contract references the installed reporter and
EMITS it (the hook calls the one library; W899), lane briefs carry the
same table (dispatch FLEET REPORT), and the install tail runs the report
through the PATH shim as its final section (every install proves the verb
live). One implementation (hooks/lib/work-report.ts) — the bin's glyph/
spend-line parser retired (W913). This supersedes the W865 prose list.
(owner GO 2026-10-19): rows = riding + queued + last-5-done (or strict
`--ids w1,w2`); columns ITEM/ST/TASK/TOKENS/CACHE/OUT-MIN/AGENT/MODEL/
EFFORT/CONSULT from each item's W776 attribution — MODEL = top model_group
(`+` when several), EFFORT = the lane's effort level (dispatch pins
SUSPENDERS_LANE_EFFORT into the per-lane 0600 settings; `work done` banks it
into the work.done event), CONSULT Y/N = the lane banked knowledge or
consulted (W909 event links); fixed-width programmatic pads; ST letters
R = riding, Q = queued, D = done, F = failed (W891 colors them on the
board). Supervisor ticks paste it verbatim — the session-start
SUPERVISOR DEFAULT contract references the installed reporter and
EMITS it (the hook calls the one library; W899), lane briefs carry the
same table (dispatch FLEET REPORT), and the install tail runs the report
through the PATH shim as its final section (every install proves the verb
live). This supersedes the W865 prose list.

- Agent skills: the repo-root `skills/` catalog installs into any agent CLI
  via `npx skills add klh/fleet` (`-g -y -a <ids>`; target ids in README
  "Install the skills as agent tools"). ChatGPT is not a CLI target — paste
  the `SKILL.md` into the conversation.

## Operations — every verb and what it is for

Shims on PATH (`coord`, `work`, `dispatch` → the installed prefix;
`~/.local/bin`, override with SUSPENDERS_SHIM_BIN). Every verb has
`--help` (per-verb usage + flags from its schema).

Work graph (`work` — the ONE ledger; never Markdown todos):

- `work ready` — claimable items · `work list` — all (◐ claimed, ⊞ split)
- `work show <id>` — the item · `work take <id> --as <sid>` — mints/attaches
  the item worktree (.worktrees/<id>, path printed; W870: never treeless
  claims) — the location-vs-claim write gate binds the claim's edits to that
  tree, refusing main-checkout edits from the claim holder
- `work allocate [--apply] [--capacity N]` — scorer-ranked plan of READY ×
  lanes (reclaimed-first FIFO, decisions {assign|recommend} with
  alloc_reason audit trail; `--apply` claims only the assign kind)
- `work done <id> --sha <sha>` — close with evidence
- `work add <title> [--parent <id>] [--priority n] [--desc ...]
[--tag t1,t2]` — mint (never invent work; empty title = unfilled item;
  W846: `--tag` stamps classification tags, comma-set — split children
  inherit the parent's)
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
- `coord ack <event-id> --as <sid>` — accept one directed message or consult
  only after acting on it; reading or receiving a WS push is delivery, not
  acceptance. `coord inbox --ack` accepts the entire pending inbox, so use it
  only after processing every displayed event.
- `coord steer <sid|label> "input" [--decide]` — steer a RUNNING lane
  mid-turn instead of kill+relaunch: accepted (queued) / pending (lane
  mid-tool) / failed (lane dead) acks; gates = one per sid per hour, the
  scrub ruleset, `.fleet/steer-paused` kill switch; `--decide` renders the
  advisory kev steer-vs-redo verdict (steer/redo/let-ride)
- `coord coordinate` — bounded peer-coordination round (W977.1, topics
  work|claims|capacity; singleflight + rate-capped, Kev `--classify`
  outbound-only; docs/design/supervisor-coordination.md)
- `coord fleet` — who is working (sessions + claims; never /tmp files)
- `coord rename --as <sid> <name> [--force]` — the ONE shared rename (W930):
  stamps sessions.tags `name` for every @name resolution; the stop gate
  syncs native CLI /rename (claude-code `custom-title`) through the same
  core, duplicate live same-project names refuse without `--force`
- `coord project identity` / `coord project rekey <old> <new>` — graph
  identity migration as a VERB (W428): one tx across work_items, work_deps,
  work_sequences, consults, consult_kb, sessions + events `$.project`;
  children-first + `PRAGMA defer_foreign_keys` (composite FKs on
  work_deps→work_items 500 otherwise); refused when the target holds items

Oracle (`oracle` — the named review/escalation tool, W647):

- `oracle review` / `oracle bugs` / `oracle analyze` — the fixed prompt
  contract (replaces ad-hoc "-review" phrasing in lane prompts); stateless,
  one request one answer. Default leg is PINNED to the :8903 local-reason
  tier (direct OpenAI-wire POST; `ORACLE_ROUTE_URL`/`_KEY`/`_MODEL` are the
  config-over-code overrides); `--cloud` fires the stronger cloud route via
  the :4000 router's own escalation leg (buckle-gate `BELT_ESCALATE_*` env,
  glm-5.3). NO automatic stuck-detection routing — a lane or human invokes
  it explicitly, every time. Exit 0 answer · 1 usage/input · 2 leg failure.

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
  - `com.suspenders.belt-swarm` — the belt kit's `supervise` supervisor
    (KeepAlive; renamed from com.belt.swarm for the W640 receipt namespace):
    spawns :4000 + the MLX specialists below (W284: the ONLY swarm
    supervisor — `com.suspenders.local-llm` is retired and rides the
    LEGACY boot-out list)
  - `com.suspenders.cloud-gateway` — cloud transport lifecycle
    (belt/bin/cloud-gateway.ts → litellm :4100); never starts
    router/swarm
  - W779 heartbeat (2026-10-18): the no-port maintenance agents (fleet-
    monitor, db-backup, harvest, quota-sweep, dispatch-watchdog, llm-
    keepwarm, coord-worker, auto-install, soak, rogue-reap W827, license-
    audit W828, metrics-alert W782.2.1, knowledge-sync W944 —
    reaps lane-leaked serve processes in stale .worktrees dirs + prunes
    merged-and-clean worktrees; `.fleet/rogue-reap-paused` pauses) are
    NOT launchd units —
    they are typed tasks fired by the ONE fleet-loop cycle, each task
    owning its cadence and fan-out (hooks/lib/fleet-loop/maintenance.ts;
    retired labels ride the services.yaml legacyLabels boot-out list)
  - `com.belt.dashboard` — fleet dashboard :7791 (LAN:
    belt.local:7791), runtime copy ~/.claude/local-llm/dashboard.ts
  - `com.suspenders.buckle-spoke` — buckle gateway :4101 (Mac spoke)
  - `com.suspenders.board` — fleet board :7799
  - `com.suspenders.fleet-pulse` — W822 periodic digest (StartInterval =
    notify.yaml pulse.interval_s, default 14400): `notify.ts pulse` composes
    lanes/READY/DONE/watchdog/decisions/commits into one notification via the
    notify.yaml 'pulse' class; every install registers it post-install
  - `com.klh-local.caddy` — the Caddy .local front
  - same namespace, no ports: knowledge-worker
  - LEGACY, never load: `com.klh.local-llm` / `com.klh.llm-keepwarm` /
    `com.klh.fleet-monitor` (superseded — installers boot them out and
    rm the plists) and `com.belt.gateway` (retired W277 — was the :4100
    litellm wrapper; a plist may linger on disk but must stay UNLOADED)
    and `com.suspenders.local-llm` (retired W284 — the suspenders
    local-llm serve fork; both installers boot it out and rm the plist)
- local-llm swarm: `bun ~/.claude/local-llm/swarm.ts status|supervise` —
  belt kit is the source (W284: the suspenders local-llm serve fork is
  retired; installs heal the runtime home's belt closure from
  packages/belt/bin). Specialists (belt registry.ts): :8901 coder · :8902
  extract · :8903 reason · :8906 danish/general · :8907 embeddings ·
  :8912 kev · :8913 rerank — the tier manifest `tier.json` scopes the
  RESIDENT set (BELT_TIER=minimal = :8902 + :8913; the rest load on
  demand). :4000 = belt/bin/router-shim.ts — the Anthropic-format API
  (complexity-v3 router) that is the seam lanes ride; `supervise` spawns
  it from the runtime-home copy
- belt router :4000 (= router-shim, see above) · litellm :4100
  (com.suspenders.cloud-gateway) · buckle spoke :4101 (Mac), hubs
  :4101 (NAS) / :4111 (desktop) · board :7799 · store :7794 (Mac) /
  :7795 (NAS) / :7796 (desktop)
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
  `buckle-spoke.env` / `buckle-desktop.env` (BUCKLE_ROOT_KEY; the spoke
  env also holds `GITHUB_COPILOT_PAT`, resolved from the 0600 `copilot.key`)
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
