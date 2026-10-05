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

NAS ($NAS_HOST — same template, compose-managed since the 2026-10-05
root-key cutover; replaces the W318-era docker-run one-offs):

    # one-time migration (run ON the NAS, host paths are NAS-local):
    #   1. stream this repo's hub-compose.yaml → /volume1/docker/hub/
    #   2. .env beside it (placeholders — real values in runtime stack.yaml):
    #        HUB_NAME=nas
    #        HUB_BUCKLE_PORT=4101  HUB_BUCKLE_BIND=0.0.0.0  HUB_BUCKLE_AUTH=on
    #        HUB_BUCKLE_REPO=/volume1/docker/hub/buckle
    #        HUB_BUCKLE_ENV_FILE=/volume1/docker/hub/buckle/buckle.env
    #        HUB_BOARD_PORT=7799   HUB_BOARD_BIND=0.0.0.0
    #        HUB_ALLOWED_HOSTS=nas-hub.local
    #        HUB_SERVICES_JSON=/state/hub-home/services.json
    #        HUB_STORE_PORT=7795   HUB_BELT_BIND=0.0.0.0  HUB_BELT_PORT=7791
    #   3. generate the break-glass root key ON DEVICE (never printed,
    #      never committed):
    #        umask 077 && printf 'BUCKLE_ROOT_KEY=%s\n' "$(openssl rand -hex 32)" \
    #          > /volume1/docker/hub/buckle/buckle.env
    #   4. docker rm the manual rows, seed the named volumes from the old
    #      host-bind state (buckle.db, belt-home incl. belt.env, hub-home,
    #      the federation signing key → hub-secrets), then:
    #      docker compose -f /volume1/docker/hub/hub-compose.yaml up -d
    #   5. verify: boot log says "root-keyed", /status 200, mint-test via
    #      /v1/admin/keys passes (statuses only — key material never echoed)

    HUB_NAME=nas docker compose -f /volume1/docker/hub/hub-compose.yaml up -d

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
