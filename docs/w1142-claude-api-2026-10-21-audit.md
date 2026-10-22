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

## Probe evidence (live, 2026-10-22, one tiny request per leg, redacted)

| leg | request | verdict |
| --- | --- | --- |
| belt router :4000 → local swarm :8902 (anthropic wire, MLX openai-compat upstream) | `claude-sonnet-4`, temperature 0.5 + top_p 0.9 + top_k 40 | **200** — accepted; routed SIMPLE/extract (Qwen3-4B). Router pins `anthropic-version: 2023-06-01` (router-swarm.ts). |
| buckle front :4101 `/w/<sid>` → glm-5.3-flash → z.ai via litellm (a→o bridge) | `glm-5.3-flash`, temperature 0.5 + top_p 0.9 + top_k 40 | **200** in 105 s (thinking burn, not a compat failure). a→o PASS_THROUGH forwarded temperature/top_p; top_k honestly degraded. z.ai accepts the params today. |
| buckle front :4101 → `claude-sonnet-5` → IKEA copilot seat | same body | **429** rate_limit in 1.4 s — the W695.6 quota wall (to ~2026-11-01). Died before param validation: copilot param acceptance UNVERIFIED live. |
| api.anthropic.com (direct) ×3 | temperature 0.5 with {} / 2023-06-01 / 2026-10-21 headers, bogus marked key | **401** authentication_error all three — auth precedes version validation; the missing-header default is unobservable without a live key. Machine carries no api.anthropic.com credential. |

## Fix shipped (this branch)

- `stripRemovedSampling` (adapters/tools.ts): a row pinning
  `anthropic-version: 2026-10-21` or setting `adapter_config.strip_sampling_params:
  true` loses temperature/top_p/top_k from its wire body — W1080
  honest-degrade class, config-over-code. Unpinned rows keep today's
  verbatim forward (copilot et al. still accept the params).
- Applied in `ANTHROPIC.buildCall` (adapters/anthropic.ts): one strip point
  covers both the same-dialect pass-through and the o→a bridged hop (bridged
  bodies flow through buildCall via defaultFetch).
- Regression: `test/adapters-sampling-strip.test.ts` — 7 cases: pinned strip
  ×2, header pin ride-along, unpinned preserve, old-version preserve, o→a
  bridge hop into a pinned row (all three gone), a→o bridge unchanged
  (temperature/top_p forward, top_k degrade). 21 pass across the two
  adapter-wire specs.
- belt needs NO code change: its explicit anthropic outbounds pin
  `2023-06-01` (escalate.ts, router-swarm.ts, m365, bench-cache); the
  `body.temperature ?? 0.7` default-fill feeds only openai-dialect local legs
  (router-shim.ts:737), which accept it. The residual risk is a future row
  moved to the new wire without its adapter_config pin — the strip then fires
  by the pin, never by guesswork.

## Pending (resume from here)

1. ~~Live probes~~ done — table above.
2. ~~Remove-or-degrade~~ done — strip shipped.
3. ~~Regression test~~ done — 7 cases green.
4. ~~Record probe evidence per leg~~ done — table above.
