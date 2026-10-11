# Overlay-flip gate — W233.5 state (2026-10-11)

Deploy-order gate (docs/enterprise-posture-audit.md ladder step 2): hubs
flip `stack.yaml` `repos` to the overlay origin + `repos.ref` BEFORE any
strip-carrying stack bump. W233.3 landed @16c1cd8 (manifest/CR strips)
and W233.4 landed @8a31e16 (belt-remote originate CLI move) — the
strips are IN; a hub deploy of any post-W233.3 stack without the flip
serves honest 501s and stops the registry.
hubctl overlay mode is landed and tested (W493.2, `fleet ce5de9a`):
overlay origin ⇒ `repos.ref` required (GH002-safe), `HUB_FLEET_REF` =
`repos.ref`, public base rides the overlay's git-dep pins.

## Per-hub state (this audit)

- **nas** — config flipped (prior lane, verified `hubctl render nas`):
  `HUB_FLEET_REF=stack-5234813`, `HUB_FLEET_REPO_URL=fleet-enterprise.git`,
  `HUB_FLEET_SRC=/src/fleet/node_modules/fleet/packages`. Deploy blocked on
  transport (route blocker, NEED_DECISION #30282; W493.3/W632 records).
- **desktop** — NOT flipped: renders the public origin
  (`HUB_FLEET_REF=523481347b6…` = the stack version,
  `https://github.com/klh/fleet.git`), no `repos:` block. Docker daemon
  down ⇒ hub dark (`coord hubs`: 0/6 up); no deploy possible until the
  daemon runs.

## The desktop flip (proposed, owner GO required)

Add under `hubs.desktop` in `~/.config/klh/stack.yaml` (the sole conf):

    repos:
      ref: stack-5234813
      buckle: https://github.com/klh/fleet-enterprise.git
      src: /src/fleet/node_modules/fleet/packages

Render-proofed via a KLH_STACK fixture built from the real profile
(one-reader `loadStack`, no config touched): the flipped desktop renders
byte-equivalent to the NAS flip — `HUB_FLEET_REF=stack-5234813`,
fleet-enterprise origin, packages src — with every desktop knob (ports,
auth on, allowed_hosts, belt/store) unchanged. Mechanics green post-W233.3
merge: `bun test hubctl-layout + hubctl-deploy` 15 pass / 0 fail;
buckle suite 452/452 on the merged tree (W233.3 contains the strips).

## Tag currency note

Tag `stack-5234813` in fleet-enterprise pins the public base at the
W233.1 seam head (spokes + entitlements moved; usage/manifest/CR moves
W233.2–W233.4 land in a LATER overlay tag). The flip is safe now and the
`repos.ref` bump rides each future stack version bump — never the 40-hex
version itself (GH002).

## Unblock

1. Owner GO on the desktop flip (this decision) → apply the stack.yaml
   edit, `hubctl deploy desktop` once the Docker daemon is up, verify
   `hubctl status desktop` sidecars.
2. Owner route restore for the NAS deploy (#30282, open) → `hubctl
   deploy nas` + `status nas`.

Both flips must land before the next strip-carrying stack version bump.
