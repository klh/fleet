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
- **Hub account-policy seam**: hub buckles boot `account policy active from
  default:general` — the per-hub `repo-tier-policy.yaml` is not
  mounted/env'd by the compose template (no `BUCKLE_REPO_TIER_POLICY`
  knob), so minted (non-root) keys hit `buckle.tier_no_upstream` on
  copilot-backed rows. Pre-existing since the W1265.1 seam landed; root-key
  rides are unaffected. Follow-up: wire the hub-local policy file into
  hubctl push + compose env.
