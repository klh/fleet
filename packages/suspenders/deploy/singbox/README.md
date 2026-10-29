# sing-box TUN + Buckle CONNECT egress (W1260.1)

Machine-level AI egress enforcement, operable end-to-end: every detected
GUI app's AI destinations ride Buckle's authenticated HTTP CONNECT relay.
sing-box TUN mode captures the apps' traffic at the kernel level
(`auto_route` + `strict_route`); `process_path_regex` + sniffed SNI pin it
to per-app `buckle-connect-<app>` outbounds. Default-ON: the operator opts
OUT via `connections.json` / the machine conf.

## Ordering law (bypass BEFORE connect)

1. `{action: sniff}` — SNI populates the domain for later matches
2. dns hijack
3. `ip_is_private` + `.local`/`.lan` → direct (LAN never captured)
4. GUI app rules: `process_path_regex` AND the full AI destination set
   (`anthropic.com claude.ai openai.com chatgpt.com`) → `buckle-connect-<app>`
5. AI fallback rule (no process match) → `buckle-connect-buckle` — the
   fail-closed gate for unknown processes; NEVER a catch-all relay
6. `final: direct` — watched-app NON-AI traffic stays direct by law

## The lifecycle CLI

    bun deploy/singbox/lifecycle.ts fill    # template → ~/.config/klh/singbox.json (0600)
    bun deploy/singbox/lifecycle.ts detect  # which GUI transports are present
    bun deploy/singbox/lifecycle.ts on      # law → relay reach → plist → owner door
    bun deploy/singbox/lifecycle.ts off     # ordered rollback: bootout → plist rm → env clear
    bun deploy/singbox/lifecycle.ts status  # UP | DEGRADED | STAGED | DOWN composite

- `fill` refuses without `BUCKLE_CONNECT_TOKEN` — never a placeholdered
  conf (the W1233 not-runnable failure mode).
- `on` never prompts for sudo: it prints the exact owner commands and
  exits STAGED (exit 4) when bootstrap needs the privileged door.
- `off` is the ordered rollback: bootout the daemon, remove the staged
  plist, `launchctl unsetenv` the proxy pairs, report `scutil --proxy`.
- `status` composes pgrep + relay TCP probe + clash-API answer + staged
  plist into one verdict; a dead relay with a live daemon is DEGRADED,
  never painted healthy (outside-process law).

## Layer law + honesty limits

- The CONNECT outbound is a **relay**: TLS stays opaque end-to-end. The
  stack sees SNI + per-app Basic-auth identity + byte counts — never
  plaintext, never wire translation (W1231 ban unaffected).
- Stock macOS TUN has no per-app BLOCKING beyond these routing rules;
  per-app firewalling needs a network-extension product — out of scope.
- `verify` (singbox.ts) rules on live clash-API rows; an empty window is
  INCONCLUSIVE, never a pass.

## GUI vs CLI steering (owner #67959)

GUI transports (Claude.app, ChatGPT.app, VS Code.app) are watched HERE —
`watched.ts` is the ONE signature source, shared by this kit and the W1234
connections emitter. CLIs (claude, codex) are NOT watched: they steer via
user-level tool config pointing at stable Buckle protocol endpoints (the
W1264.2/W1265 render table), never per-repo `.codex/config.toml`. Tool
detection/installation belongs to the Vercel skills catalog via
`fleet-install` — this kit never detects tools. A CLI's AI destinations
still hit the `buckle` fallback rule — CONNECT stays the fail-closed AI
gate either way.
