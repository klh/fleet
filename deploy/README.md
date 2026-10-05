# deploy/ — hub deployment (W310)

One parameterized compose (`hub-compose.yaml`) + the runtime-config shape
(`stack.example.yaml`). The topology law: **start topology, not hardcoded
one-offs** — a local user runs several hubs, hubs declare peers (sub-hubs),
everything is data in runtime config.

## Deploy a hub

Docker Desktop (this Mac):

    HUB_NAME=desktop HUB_BUCKLE_PORT=4111 HUB_BOARD_PORT=7809 \
    HUB_STORE_PORT=7796 HUB_BELT_PORT=7792 \
    docker compose -f deploy/hub-compose.yaml -p klh-hub-desktop up -d

NAS ($NAS_HOST — same template, compose-managed via hubctl; replaces the
W318-era docker-run one-offs):

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

## Enterprise layer

The private `*-remote` overlays (buckle-remote, belt-remote,
suspenders-remote) are config-over-code: the public bases run, the overlay
profiles set auth.required, tokens.ttlHours, oidc.enforced (W191 lives in
the base), admin.gui. Entra ID tenant/app values live only in stack.yaml.

## Browsing a remote hub board

Boards enforce the W264 host guard: only `*.local` names + loopback pass.
A remote hub board is fronted by the Mac's Caddy under a `<label>.local`
name (klh-local register <label> --upstream host:port — b6528ba) with the
board's SUSPENDERS_ALLOWED_HOSTS set to that name. Example:
https://nas-hub.local → $NAS_HOST:7799.
