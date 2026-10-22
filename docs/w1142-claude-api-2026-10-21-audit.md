# W1142 — Claude API 2026-10-21 sampling-param removal: buckle/belt audit

Status: premise VERIFIED (first-tier), leg probes + code changes pending (paused
2026-10-22, operator safe pause — ramp33).

## Premise (first-tier, verified 2026-10-22)

Source: docs.anthropic.com `/en/api/migration-2026-10-21` ("Migrating to API
version 2026-10-21") — fetched live, 2026-10-22.

- The Anthropic Messages API now has a second API version, `2026-10-21`
  (changelog nav: newest `2026-10-21`, `older: ["2023-06-01"]`).
- **Hard 400**: "a request that sends `temperature`, `top_p`, or `top_k`
  returns a 400 error, even at the parameter's default value." (Not ignored,
  not deprecated-and-warned — rejected.)
- Escape hatches the doc offers: (a) stop sending the parameters — sampling
  falls back to defaults incl. temperature 1.0, identical to a `2023-06-01`
  request that omits them; (b) keep the request on `2023-06-01` (i.e. pin the
  `anthropic-version` header).
- Scope notes: newer models (Claude 4.7+) already accept defaults-only; older
  models (e.g. Sonnet 4.6) lose explicit sampling control under the new
  version.

This upgrades the brief's premise: the W1080 "honest-degrade on unknown
params" class applies, and additionally any leg that DEFAULT-FILLS temperature
(e.g. belt's `body.temperature ?? 0.7`) is a new-400 source even when the
client sends nothing.

## Surface map (code, verified in worktree @ fe5c8725)

- `packages/buckle/src/adapters/tools.ts:92` — `PASS_THROUGH` set forwards
  `temperature` + `top_p` on BOTH bridges (a→o at :123, o→a at :424). `top_k`
  already degrades honestly (a→o, :169). So buckle→anthropic-upstream legs
  forward client temperature/top_p verbatim — 400 under the new version.
- `packages/belt/bin/router-shim.ts:727` — `body.temperature ?? 0.7`
  DEFAULT-FILL: belt injects 0.7 when the client omitted temperature, then
  routes to local/openai legs. Any anthropic-dialect leg reached with a
  filled temperature would 400.
- `packages/belt/bin/route-policy.ts:438,501,565,591`,
  `packages/belt/bin/direct-client.ts:51,168`,
  `packages/belt/bin/anthropic-shim.ts:12,96` — temperature plumbed/set on
  outgoing bodies.
- `packages/buckle/src/expand.ts:59-72`, `packages/buckle/src/eval/runner.ts:42`,
  belt bench/distill/enhance/fit-classifier — internal callers that set
  `temperature: 0` for determinism; these are OUR calls to OUR upstreams, in
  scope only if they ride an anthropic-dialect leg.

## Pending (resume from here)

1. Live probes, one tiny request per leg, redacted keys: direct Anthropic
   (new version header vs 2023-06-01), z.ai via litellm :4100, copilot seat —
   does each still accept temperature/top_p/top_k on the wire today?
2. Remove-or-degrade: params the target wire dropped must leave the forwarded
   body (honest-degrade, W1080 style) or clamp per-row via adapter config.
3. Regression test: the three params through every dialect bridge assert no
   hard 400 (i.e. stripped/degraded, never forwarded to a 2026-10-21 leg).
4. Record probe evidence per leg in this file (audit row).
