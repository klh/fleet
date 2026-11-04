# v2.1.4 release verification — W2596

Release tag `v2.1.4` (fleet f23da0ba, enterprise 2fbf7342) rolls W2594
(`strip_body_fields` on every copilot/claude hub row + ANTHROPIC.buildCall
hook) and W2595 (litellm behind every buckle — compose profile + hubctl
parity verb; live copilot re-points stay frozen pending this proof).

## Verification (owner addendum, 2026-11-03)

| Check | Result |
| --- | --- |
| (a) hostile body `claude-sonnet-5.5` + thinking+reasoning_effort+effort via ikea buckle | **200** `"ok"` (pre-fix 400; trace-proof strip applied; probe keys minted + revoked) |
| (b) `/v1/models` per hub | desktop **200** 22 models (8 claude) · ikea **200** 21 (8 claude) · zai **200** 13 (glm only) · nas **200** 2 (local swarm) |
| (c) `hubctl status <hub>` | desktop / nas / zai / ikea — **all healthy** on v2.1.4 (post-settle re-probe; first probe shows board/mdns sidecars still starting — expected cold-start) |
| (d) hubctl verbs + board | render/mint/push/up/status/deploy exercised ×4 hubs; FLEET_VERSION=v2.1.4 in container env; board lanes view renders the live lane |
| (e) minted-key hostile-body probe via the LANE path (W2632 receipt, 2026-11-04) | **200** `"ok"` — knob-declared ikea hub deploy, boot log `account policy active from /etc/klh/repo-tier-policy.yaml (1 classes)`; minted `buckle:proxy:WRITE_` key 18bc5e240928 (600 s) POSTed `claude-sonnet-5` + thinking+reasoning_effort+effort+parallel_tool_calls+anthropic_beta+mcp_servers → **200 in 811 ms**; key revoked (post-revoke probe **401**) |

## Deploys

- Machine pins: settings.json + stack.json `version: v2.1.4`, per-hub
  `repos.ref: v2.1.4` (enterprise overlay origin).
- Enterprise overlay: pin commit 2ac76081 + lock refresh e0d63790, tag
  `v2.1.4` (2fbf7342) pushed. Origin/main on fleet-enterprise still needs
  the ladder/owner to advance it (lane push-guard blocks direct main push).

## Known gaps (recorded, not release-blocking)

- **Route-preflight settings.json regression** (pre-existing, hit during
  deploy): `loadStack()` projects from settings.json but drops top-level
  `route_preflight`, and settings' schema rejects the top-level key, while
  `routeInputs` ignores the per-hub `route_preflight` block — the nas
  ollama leaf went unmapped and `hubctl deploy` refused. Worked around via
  `KLH_STACK` pin to legacy stack.json for this release's deploys. Fixed
  properly by W2630 (hub-level `route_preflight.terminal_origins` union).
- **Hub account-policy seam — CLOSED by W2632** (verified live 2026-11-04,
  check (e) above): hub buckles booted `account policy active from
  default:general` because the compose template carried no
  `BUCKLE_REPO_TIER_POLICY` env/mount; W2632 wired the
  `secrets.repo_tier_policy` knob through render + push + compose, the
  ikea hub now boots the staged policy, and the minted (non-root) lane
  key reaches copilot-backed claude rows **200** — the W2596 follow-up is
  discharged.
