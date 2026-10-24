# sing-box TUN egress enforcement (W1233)

Per-process egress enforcement for Claude.app + ChatGPT.app on muramasa:
sing-box TUN mode captures the apps' traffic at the kernel level
(`auto_route` + `strict_route`) and `process_path_regex` rules pin it to
the `hub-relay` forward proxy — even when apps ignore the system proxy
(websockets, child processes, updaters).

## Layer law (complement, never replacement)

- **sing-box** = network-layer enforcement/audit. Bytes flow through
  muramasa's TUN; attribution is per-process.
- **buckle** (W1230) = the inference-layer gateway for Claude Desktop
  (`/v1/messages`). This kit never terminates or translates LLM wires.
- The `hub-relay` outbound is a **forward proxy**: it relays the app's
  TLS to its real destination (ChatGPT stays OpenAI-bound, W1231). It is
  never a wire translation.
- Enforcement is **fail-closed**: watched processes are pinned to the
  `hub-relay` outbound — if the relay is down, their traffic fails rather
  than falling back to direct.

## Layout (config-over-code)

- Repo: `config.template.json` — the fleet-law reference shape with
  `<PLACEHOLDER>`s. NOT runnable by design.
- Machine: `~/.config/klh/singbox.json` — the real config, 0600
  (`KLH_SINGBOX_CONF` overrides). Repos carry placeholders only.

## Usage

    bun deploy/singbox/singbox.ts seed              # template → machine conf, once
    # fill every <PLACEHOLDER>, then:
    bun deploy/singbox/singbox.ts check             # fleet-law validation
    bun deploy/singbox/singbox.ts verify [--watch 30]
    #   SINGBOX-VERIFY: PASS | FAIL - <reason> | INCONCLUSIVE - <reason>
    #   exit: 0 PASS · 1 FAIL · 3 INCONCLUSIVE

`check` refuses: missing TUN capture (`auto_route`/`strict_route` off), a
non-loopback clash API, a missing/broken `hub-relay` forward proxy, a
catch-all routed anywhere but `direct`, missing DNS hijack, missing
watched-process coverage for either bundle, and any unfilled placeholder.

`verify` reads sing-box's clash API (`GET /connections`, loopback-only,
bearer-authed) and rules on live rows: a watched process on `direct` is a
leak (FAIL); watched traffic on `hub-relay` with per-process byte counts
is the acceptance evidence; an empty window is INCONCLUSIVE, never a
pass.

## Bring-up (manual, root)

TUN mode needs root; this kit does NOT automate privileged network
changes on the owner's Mac:

    brew install sing-box   # >= 1.12 (type-keyed DNS servers)
    sudo sing-box run -c ~/.config/klh/singbox.json

Run it as a root LaunchDaemon for persistence; `verify --watch` is the
health check (run it from a non-root session — the outside-process law:
the enforcement point never paints itself healthy).

## Firewall complement — honest limits

Stock macOS cannot block per-app OUTBOUND traffic (pf has no process
match; the application firewall filters inbound). The enforcement
guarantee therefore comes from the TUN itself: kernel-level capture means
watched processes have no routable path around sing-box, the DNS hijack
removes plain-DNS leaks, and `verify` detects any direct-egress hole.
Per-app firewalling beyond this needs a network-extension product — out
of scope here.

## The hub relay endpoint — open decision

The config names `hub-relay` but the stack does not yet run a generic
forward relay on the hub (services.yaml has none; buckle is an LLM
gateway, not a TCP relay). Candidates: a hub-side sing-box/mixed relay in
hub-compose, or an ssh-forwarded proxy (the trace-tunnel pattern). Until
one lands, point `hub-relay.server` at whatever forward proxy the owner
designates; `verify` proves enforcement + attribution at muramasa either
way.

## Regex choice — claude CLI

The template regexes anchor at `^/Applications/(Claude|ChatGPT)\.app/`:
the claude CLI (`~/.claude/local/claude`) is EXCLUDED by construction
(lanes must not detour through the hub relay). `check` verifies the
exclusion holds; editing a rule to include the CLI is an explicit,
auditable conf change.
