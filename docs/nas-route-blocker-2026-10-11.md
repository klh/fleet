# NAS route blocker — W493.3 deploy diagnosis (2026-10-11)

W493.3 (deploy fleet-enterprise to the nas hub, phase B) cannot run
`hubctl deploy nas` from this machine. Record of the evidence, so the next
lane or the owner starts from facts, not a re-derivation.

## What is verified working

- stack.yaml flip is intact and renders correctly:
  `bun packages/suspenders/deploy/hubctl.ts render nas` →
  `HUB_FLEET_REF=stack-5234813`, `HUB_FLEET_REPO_URL=fleet-enterprise`,
  `HUB_FLEET_SRC=/src/fleet/node_modules/fleet/packages`.
- The NAS origin itself is ALIVE: Cloudflare answers **526** on :443
  (edge reached the origin, origin cert fails CF validation — consistent
  with the DSM 7.4.1 upgrade resetting the TLS cert), and origin nginx
  answers plaintext-400 on CF's TLS-class ports (2053/2083/2087/2096/8443).

## What is blocked and why

- `nas.threads.dk` resolves to Cloudflare proxy IPs (104.21.x / 172.67.x),
  so ssh :22 and board :7799 are unroutable — CF does not proxy those
  ports. No origin mapping exists on any CF-proxied port (2052–8880
  probed; TLS-class ports time out on proper HTTPS).
- This Mac is on **10.30.2.0/24** (en0); the NAS-side IPs in ssh
  known_hosts are all **192.168.1.0/24** and dark — the Mac is off the
  NAS's LAN. No mDNS candidates resolve, no tailscale IPv4 is up.
- `deploy/hubctl.ts:117` is ssh-only for remote hubs (`ssh`/`scp -O`),
  so mint/push/up cannot run from here by any in-repo path.

## Resume

1. Owner restores a route: ssh port-forward/CF tunnel/split DNS to the
   origin IP, or runs the deploy from the home LAN (NEED_DECISION #30282).
2. `bun packages/suspenders/deploy/hubctl.ts deploy nas` then
   `hubctl status nas` (health sidecars) — close W493.3 DONE with the
   status output.
3. Route probes for re-verification: TCP22 + DNS checks via
   `.tmp-tcp22.ts` / `.tmp-probe.ts` in the W493.3 worktree; `xh --no-verify
   GET https://nas.threads.dk/` → 526 still means origin alive.

Coord state: fact `finding.w493.3`, capsule @ this commit, NEED_DECISION
#30282 open.
