# NAS flip retry — W632 (2026-10-11)

Retried W493.3's failed `hubctl deploy nas` (its diagnosis:
`docs/nas-route-blocker-2026-10-11.md` on `suspenders/W493.3`, fact
`finding.w493.3`). Same blocker; fresh evidence from this retry.

## What held (config flip is intact)

`bun deploy/hubctl.ts render nas` renders the flip clean:

- `HUB_FLEET_REF=stack-5234813`
- `HUB_FLEET_REPO_URL=https://github.com/klh/fleet-enterprise.git`
- `HUB_FLEET_SRC=/src/fleet/node_modules/fleet/packages`

The mission's stack.yaml precondition (nas.repos → fleet-enterprise,
ref `stack-5234813`) is confirmed as hubctl sees it. No config work
needed — the blocker is transport only.

## What failed (identical to W493.3)

`bun deploy/hubctl.ts deploy nas` dies on the FIRST ssh leg (mint):

```
ssh: connect to host nas.threads.dk port 22: No route to host
    at mintRootKey (deploy/hubctl.ts:154)
    at deployHub (deploy/hubctl.ts:363)
```

Note: `hubctl.ts` invokes ssh via `execFileSync` with no `ConnectTimeout`
(deploy/hubctl.ts:117), so each attempt hangs ~75 s before this error.

Fresh probes (2026-10-11 ~07:15 UTC, from this Mac):

- DNS: `nas.threads.dk` → 104.21.23.5, 172.67.208.45 (Cloudflare proxy)
- TCP 22 / 7799: dark (SYN timeout); TCP 443: open, CF answers 526
  (origin nginx alive, cert unvalidated)
- Mac en0 = 10.30.2.0/24; NAS-LAN candidates are 192.168.1.0/24 (dark)
- No ssh-config ProxyJump for the NAS, no tailscale CLI, no /etc/hosts
  override

## Unblock

Route restore (NEED_DECISION #30282): ssh port-forward / CF tunnel /
split DNS / grey-cloud the record — or the owner runs the deploy from
the home LAN (option b). Resume on a routed machine:

```
bun packages/suspenders/deploy/hubctl.ts deploy nas
bun packages/suspenders/deploy/hubctl.ts status nas   # probe sidecars
```
