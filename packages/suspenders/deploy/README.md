# deploy/ — hub deployment (W310)

One parameterized compose (`hub-compose.yaml`) + the runtime-config shape
(`stack.example.yaml`). The topology law: **start topology, not hardcoded
one-offs** — a local user runs several hubs, hubs declare peers (sub-hubs),
everything is data in runtime config.

## Deploy a hub

One command, any hub (W363) — the hub's section in the machine stack.yaml is
the whole brief; the installer materializes it (mint → push → up, probe-gated
status):

    bash install.sh --hub <name>          # from packages/suspenders
    bun deploy/hubctl.ts deploy <name>    # the same chain, hubctl-direct
    bash install.sh --hub <name> --dry-run  # renders the hub .env only

Docker Desktop (this Mac): the desktop hub's deploy.dir is a local path and
no ssh target is declared, so mint/push/up run locally. NAS ($NAS_HOST —
same template, compose-managed via `--hub`; retires the W310 Docker Desktop
one-off and the W318-era docker-run rows):

    # the machine config (~/.config/klh/stack.yaml) declares the hub: ports,
    # binds, repo trees, deploy transport (ssh/dir/docker), secret PATHS.
    # hubctl materializes everything from it — nothing hand-typed:
    #   bun deploy/hubctl.ts mint <hub>     # secrets ON the hub (0600, idempotent)
    #   bun deploy/hubctl.ts push <hub>     # compose template + rendered .env
    #   bun deploy/hubctl.ts up <hub>       # docker compose up -d
    #   bun deploy/hubctl.ts status <hub>   # per-service health probes
    # one-time cutover from manual rows: hubctl push + mint, then stop/rm the
    # docker-run containers, seed the named volumes from the old host-bind
    # state (buckle.db, belt-home incl. belt.env, hub-home, the federation
    # signing key → hub-secrets), hubctl up, hubctl status.
    # Verified: boot log "root-keyed", /status 200, mint-test via
    # /v1/admin/keys (statuses only — key material never echoed).

Ports per hub live in `~/.config/klh/stack.yaml` (mode 600) — the
placeholders here show the shape only. `~/.claude/local-llm/hubs.json` holds
the label → candidate-URL registry `resolveHub` walks (candidates give the
fault tolerance: several URLs per hub label, first healthy wins).

## Synthetic readiness (W467)

A `/status` answer proves the gate responds; only a real completion proves
the serving chain (auth → routing ladder → upstream → response). The
`buckle-ready` sidecar POSTs a 1-token chat completion through the hub's own
front every 60s and serves the verdict on its own port (`/healthz`,
`/status` — same wire contract as the *-health sidecars):

- the model is machine-level config: `ready_model:` in the hub's stack.yaml
  section (`HUB_READY_MODEL`, template default `general`) — it must name a
  model the hub's routing ladder actually serves;
- the request rides the same break-glass root credential as the gate
  (`buckle.env`), resolved inside the container via `--auth-env` — an unset
  credential fails closed (config error, never "up");
- `hubctl status` reports the row and gates the exit code on it; compose
  health still hits `buckle-health` — a dead upstream degrades the verdict,
  it never restart-loops the gate.

## Source pinning (mono deploy, W422.7)

Hubs build from ONE pinned Fleet monorepo checkout, not per-package repos:
the compose `fleet-repo` sidecar clones `$HUB_FLEET_REPO_URL` at
`$HUB_FLEET_REF` and every service runs from its `packages/<name>` subtree
(`fleet-deps` installs the workspace once, frozen-lockfile). hubctl renders
both from the stack's `version:` — a hub deploy without a pinned version
(a branch name, `main`) is refused, per-package refs/origins are rejected,
and the archived `klh/{buckle,suspenders,belt}` origins cannot deploy the
monorepo. One version string pins the whole hub (stack.yaml law).

## Runtime + embedded SQLite verification (W443)

Fleet's ledgers run WAL, so the artifact's embedded SQLite must carry the
[WAL-reset fix](https://sqlite.org/wal.html#walresetbug) — the race is
present 3.7.0 → 3.51.2, fixed in 3.51.3 (2026-03-13), backported to
3.44.6/3.50.7. The verdict reads the ARTIFACT, never the host `sqlite3`:

- **Hub + sim containers** run `oven/bun:1`, whose bun vendors its own
  SQLite amalgamation on Linux. `deploy/runtime-info.ts` reports and gates
  it; the CI `runtime-sqlite` job runs `--check` inside the same floating
  tag every push, and `hubctl status`/`deploy` exec it in the running
  buckle-hub (informational — health gates the exit code).
- **Verified (2026-10-07):** `oven/bun:1`, `1.4` and `1.4.2` resolve to one
  digest family, bun v1.4.2 vendors SQLite **3.53.2** (source id
  `2026-06-03 …f1a24`, `src/jsc/bindings/sqlite/sqlite3.c`) ≥ 3.51.3. bun
  main vendors 3.53.4.
- **Residual exposure:** bun on **macOS links the system SQLite** (Apple
  build — source id carries the `aapl` suffix); this Mac's bun 1.4.2 reports
  3.51.0, whose base is in the affected range and whose Apple patch state
  cannot be verified from outside. Mac-side runtimes (spoke, governor) stay
  exposed until the advisory's fix ships in an Apple system update — the
  probe prints `UNVERIFIED` there by design.

A version below 3.51.3 passes `--check` only with documented vendor-backport
evidence (`SQLITE_PATCH_EVIDENCE` env).

## Enterprise layer

The private `*-remote` overlays (buckle-remote, belt-remote,
suspenders-remote) are config-over-code: the public bases run, the overlay
profiles set auth.required, tokens.ttlHours, oidc.enforced (W191 lives in
the base), admin.gui. Entra ID tenant/app values live only in stack.yaml.

## Peer edges

Hubs declare peers in runtime config: `hubs.<label>.peers` lists hub LABELS
this hub reaches directly — the start-topology graph is data, never
hardcoded (hubctl reads it; `deploy/stack.example.yaml` shows the shape).
First edge (W322): the nas hub declares `desktop`. The belt-remote hub
profile mirrors its hub's edges as `federation.peers` — labels only, the
host/port/key values stay behind the labels in stack.yaml.

Propagation (W362): a hub pulls each declared peer's
`/federation/policy-manifest` on an interval (`hooks/bin/federation-peers.ts`;
the compose `peer-pull` sidecar runs it on hubs, labels via the
hubctl-rendered `HUB_PEERS`). The content-addressed manifest version is the
change detector — a version flip on the next cycle means the peer's policy
changed; per-peer last-known state lives under the federation home
(`federation-peer-<label>.json`). A peer that is down degrades one cycle
(last-known kept), never blocks the hub. Peer auth = a spoke-scoped key
minted on the PEER hub (`buckle:spoke:READ_`), resolved per label by the
same chain as the URL (env override / hubs.json registry).

## Browsing a remote hub board

Boards enforce the W264 host guard: only `*.local` names + loopback pass.
A remote hub board is fronted by the Mac's Caddy under a `<label>.local`
name (klh-local register <label> --upstream host:port — b6528ba) with the
board's SUSPENDERS_ALLOWED_HOSTS set to that name. Example:
https://nas-hub.local → $NAS_HOST:7799.
