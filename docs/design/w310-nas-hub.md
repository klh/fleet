# W310 — NAS hub deploy record (2026-10-03)

The first real hub of the start-topology, deployed tonight. Real hosts live
in runtime config (`~/.config/klh/stack.yaml`, mode 600 — to be created from
deploy/stack.example.yaml); this record uses `$NAS_HOST`.

## What runs

Four containers, host networking, `restart: unless-stopped`, oven/bun:1,
repos bind-mounted ro from /volume1/docker/hub/{suspenders,belt}, state in
/volume1/docker/hub/state:

| service        | port | notes                                                         |
| -------------- | ---- | ------------------------------------------------------------- |
| nas-buckle-hub | 4101 | pre-existing (W200 era), BUCKLE_AUTH=on, BUCKLE_BIND=0.0.0.0  |
| nas-hub-store  | 7795 | hub governor store (W149 /auth/* on it)                       |
| nas-hub-board  | 7799 | fleet board over the hub governor.db, SUSPENDERS_BIND=0.0.0.0 |
| nas-hub-belt   | 7791 | belt dashboard, bridge-free host net                          |

## The commands

    $SSH $NAS_HOST 'mkdir -p /volume1/docker/hub/{suspenders,belt,state/hub-home,state/belt-home}'
    # ship public-base trees (git archive HEAD | tar) + node_modules, ro binds
    git -C suspenders archive HEAD | gzip | ssh $NAS_HOST 'cat > /tmp/s.tgz'
    ssh $NAS_HOST 'tar xzf /tmp/s.tgz -C /volume1/docker/hub/s design:'
    # containers (one per service; kk has docker rights, no sudo)
    docker run -d --name nas-hub-store --network host -e HOME=/state/hub-home \
      -v .../suspenders:/src/suspenders:ro -v .../state:/state oven/bun:1 \
      bun /src/suspenders hooks/bin/store-server.ts --port 7795
    # board adds SUSPENDERS_BIND=0.0.0.0 SUSPENDERS_ALLOWED_HOSTS=nas-hub.local
    # belt adds BELT_PORT=7791

## Browsing (the W264 guard)

The board answers only `*.local` + loopback Host names. On the Mac:
klh-local register nas-hub --upstream $NAS_HOST:7799 (b6528ba) fronts it at
https://nas-hub.local; the board allows that name via SUSPENDERS_ALLOWED_HOSTS.
A proxy-style mDNS claim (dns-sd -P nas-hub _http._tcp local 443
nas-hub.local $MAC_IP) keeps the name resolving (klh-local's claim is the
persistent home for it; W317 tracks the register-reload EACCES quirk).

## Open

- stack.yaml: create from deploy/stack.example.yaml — needs owner values
  (Entra tenant/app, hub peers).
- NAS buckle repo copy is W200-era — redeploy on next buckle main cut-over.
- W314 (work-CR delegation e2e) + W315 (Playwright boards e2e) close the
  owner's "distributes work items to them" + "GUIs change" asks.
