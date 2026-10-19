# litellm-behind-buckle — deep review (W499)

Audit date 2026-10-19. Surfaces: (1) the LiteLLM router config + fallback
ladders, (2) buckle adapter passthrough fidelity, (3) LiteLLM features the
stack does not use yet. Method: live machine config read
(`~/.claude/local-llm/litellm.yaml`, generated 2026-10-15T14:35Z),
generator + policy sources in `packages/belt/bin/`, buckle adapter sources
in `packages/buckle/src/` (every claim file:line-cited and spot-verified),
LiteLLM docs fetched from docs.litellm.ai (pages cached in `.docs-stage/`
during the review). Nothing was fixed — this document and the minted work
items are the deliverable.

## Finding index

| # | Severity | Finding | Where |
|---|----------|---------|-------|
| F1 | HIGH | Live :4100 config has NO fallback ladders — the W219.2 fix is not live | F1 below |
| F2 | MED | The fallback drill cannot detect F1 while z.ai is healthy | F2 below |
| F3 | MED | Ladder coverage: only the 3 glm groups have ladders | F3 below |
| F4 | MED | Cross-dialect (translated) hops drop response_format, cache usage, reasoning deltas; synthesize max_tokens 4096 | buckle bridge |
| F5 | LOW | `include_usage: true` forced on all openai streams, overriding an explicit client `false` | openai-compat.ts |
| F6 | LOW | Upstream 429/5xx bodies are replaced, never passed through | buckle router |
| F7 | LOW | Anthropic-dialect model rows are hardcoded in the generator (config-over-code smell) | gateway-config.ts |
| F8 | INFO | DB-gated LiteLLM features (virtual keys, budgets, spend) remain deliberately off | surface 3 |

## Surface 1 — fallbacks

### F1 (HIGH): the live gateway config has no fallback ladders

`~/.claude/local-llm/litellm.yaml` (generated 2026-10-15T14:35:13Z by
`gateway-config.ts`) contains `router_settings` with `num_retries: 0` and
**no `litellm_settings` section at all**. The 2026-10-06/W219.2 fix —
ladders under `litellm_settings.fallbacks` (the placement the installed
LiteLLM proxy actually reads; `router_settings.model_group_fallbacks` is a
dead key) — is therefore NOT live on :4100 today.

Evidence chain:

- Live file: `router_settings.num_retries: 0`, no `litellm_settings` block
  (verified by direct read 2026-10-19).
- `emitRouterSettings` (`packages/belt/bin/router-policy.ts:112`) emits
  `num_retries` from `litellm_num_retries` — the live `0` can only come
  from a generation-time policy carrying `gateway.litellm_num_retries: 0`.
  The current runtime policy (`~/.claude/local-llm/routing-policy.yaml`)
  has neither that key nor `litellm_fallbacks: false`, so the live file was
  generated against an older/divergent policy and never re-generated after
  the policy correction.
- Read-only probe of the current policy through the same emit path
  (`loadGatewayPolicy()` → `emitRouterSettings`/`emitFallbackSettings`)
  produces `num_retries: 1` and the three glm ladders correctly — the
  generator and committed policy are right; the ACTIVATION is stale.
- `git log` on `packages/belt/bin/routing-policy.yaml`: W219.2 landed
  2026-10-07, W648 2026-10-11, W289 2026-10-15 — the committed policy has
  carried ladders since 10-07. The 10-15 14:35Z generation predates the
  10-15 18:04 W289 commit and diverges from both.

Consequence: a z.ai outage (the 2026-10-06 TLS event) hard-fails every
glm-group lane again — exactly the failure W219.2 was folded to prevent.
Backups `litellm.yaml.before-retry-owner-20261007` and the owner "retry"
work around 10-07 suggest the retry-off state was deliberate at one point;
it was never re-folded.

### F2 (MED): the drill cannot see a missing ladder while z.ai is up

`fallback-drill.ts` (`packages/suspenders/hooks/bin/fallback-drill.ts`,
run by llm-keepwarm every 4 min) probes z.ai reachability, then fires one
1-token completion for `glm-5.3-flash` through the gateway. A pass means
"gateway answered" — which, with z.ai healthy, is trivially true with or
without ladders. The drill only exercises the ladder on the dark path
(z.ai down), i.e. only after the outage has already begun. F1 sat
undetected for 12 days because of this.

### F3 (MED): ladder coverage is 3 of 16 model groups

Live `model_list` groups: `local-coder`, `local-extract`,
`local-reason`, `local-general`, `nas-qwen2.5-0.5b`, `zai-glm-5.3-flash`,
`zai-glm-5.3-flashx`, `zai-glm-5.3`, `zai-glm-5.2`, `glm-5.3-flash`,
`glm-5.3`, `glm-5.2`, `claude-sonnet-5`, `claude-haiku-4-5`,
`local-swarm`, `gpt-5.2`. Ladders exist (in the committed policy) only for
`glm-5.3-flash`, `glm-5.3`, `glm-5.2` → zai twin → `local-reason`.

Gaps, in traffic order:

- `zai-glm-*` groups (the openai-dialect twins buckle prefers FIRST for
  glm groups, `upstreams.yaml`): no litellm ladder. An address to the twin
  directly dies with z.ai. Buckle's own group ladder partially compensates
  (twin → anthropic dialect → :8902), but both z.ai rungs die together.
- `claude-sonnet-5` / `claude-haiku-4-5` rows target
  `api.anthropic.com` under `ANTHROPIC_API_KEY` — dormant until that key
  exists; if a client ever addresses the litellm group directly it hard
  401s. Buckle never sends those names to :4100 (its claude-* groups alias
  to `zai-glm-5.3-flash`), so this is latent, not active.
- `local-*` groups: no ladder when a specialist port is cold/dead; the
  router (belt :4000) owns spawn/fallback for those classes, so this is
  arguably correct — but `nas-qwen2.5-0.5b` and `gpt-5.2` are bare rows
  with no ladder and no consumer.
- Owner directive respected in the current ladders: never `flashx`, never
  same-family saturation — any ladder extension must keep that rule.

Tuning (current state is sane): inner `default_litellm_params.max_retries:
0` is correct — it keeps the engine from sleeping on provider `retry-after`
(lesson.retry-after-uncapped-floor); router `num_retries: 1`,
`allowed_fails: 3`, `cooldown_time: 30` match the policy defaults.

### context_window / content_policy fallbacks

Not configured. `litellm_settings.context_window_fallbacks` would rescue
oversized lane requests that overflow a local specialist's context
(currently a hard 400); `content_policy_fallbacks` has no obvious fleet
consumer. Verdicts from the fetched docs are recorded in surface 3.

## Surface 2 — buckle proxy passthrough

Architecture: `handlers.ts` (ingress, `/v1/chat/completions` + 
`/v1/messages`) → `router.ts` (group ladder) → `bridge.ts` (translation
tier) → `adapters/{openai-compat,anthropic}.ts` (`buildCall`) → `wire.ts`
(fetch). Same-dialect hops are pass-through-first: the body is spread
verbatim and response bytes are tee'd, never re-serialized
(`openai-compat.ts:29-45`, `handlers.ts:639-661, 670-713`). W457's cache
field verification holds.

Verified pass (same-dialect, the path to :4100): streaming SSE incl.
`[DONE]` and keep-alives, tool calls/parallel/`tool_choice`, finish_reason
mapping (`tools.ts:44-59`), usage accounting incl. cache_read +
cache_creation capture on the sniff branch (`sse.ts:95-111`,
`usage.ts:19-64`), system prompts (both directions), multi-turn ordering,
reasoning_effort forwarding within the {low,medium,high,xhigh,max}
whitelist (`tools.ts:119-128`), timeouts (TTFB 120s, idle 60s, total 900s,
caller abort → 499).

Deviations found (each is warned, none is silent):

- **F4 (MED) — translated (cross-dialect) hops are lossy.** The
  openai→anthropic bridge drops `response_format`/json_schema
  (`tools.ts:351-360`, in `OPENAI_DEGRADE`), drops
  frequency/presence_penalty, logprobs, n, seed, logit_bias,
  `parallel_tool_calls`; `thinking_delta`/`reasoning_content` stream
  deltas are dropped with a warning (`tools.ts:648-658, 929-931`);
  `cache_creation_input_tokens` has no openai-wire representation on
  bridged legs (`tools.ts:283-286`); and a client omitting `max_tokens`
  gets a synthesized `DEFAULT_MAX_TOKENS = 4096` (`bridge.ts:31,61`).
  The bridge's reject-verbose-then-skip contract means requests carrying
  untranslatable fields (incl. any unknown top-level field) skip the hop
  entirely; if only cross-dialect deployments remain, the request 502s.
- **F5 (LOW) — forced `include_usage: true`** on every openai-dialect
  stream (`openai-compat.ts:33-36`) overrides an explicit client
  `stream_options.include_usage: false`. Matches LiteLLM's own semantics
  (the file cites streaming_handler.py) but is a hardcoded overwrite.
- **F6 (LOW) — upstream error bodies are replaced.** 429s are rebuilt
  into the router error envelope (`router.ts:256-291`, `errors.ts:232-245`)
  with retry-after forwarded/derived; ratelimit headers are renamed
  `x-upstream-ratelimit-*` (`handlers.ts:613-624`); exhausted 5xx chains
  answer a generic 502 problem+json (`handlers.ts:604-606`) — the
  provider's 5xx body never reaches the client.
- The anthropic client-leg stream is deliberately re-framed (W616.1):
  `ping` events dropped, corrupt events quarantined, framing
  canonicalized (`sse.ts:154-252`) — documented defect mitigation, listed
  here for completeness (NOT byte-intact by design).
- Client request headers are not forwarded upstream (only
  content-type/authorization/tracepath/adapter_config statics,
  `types.ts:104-114`) — `anthropic-version`/`anthropic-beta` from clients
  are dropped.

## Surface 3 — LiteLLM features not yet used

Facts from docs.litellm.ai (fetched 2026-10-19; pages cached under
`.docs-stage/`). Verdicts for this stack: LiteLLM :4100 behind buckle
auth, master_key only, no `DATABASE_URL`, single instance.

| Feature | DB/Redis? | Verdict | Notes |
|---------|-----------|---------|-------|
| `litellm_settings.fallbacks` | none | IN USE (see F1) | Format confirmed: list of single-key maps; fires after `num_retries` exhausted; works on streaming when the stream fails before first chunk |
| `context_window_fallbacks` | none | USE candidate | Rescues oversized requests hard-400ing on local specialists; REQUIRES `router_settings.enable_pre_call_checks: true` or it is inert |
| `content_policy_fallbacks` | none | SKIP | No fleet consumer today |
| `default_fallbacks` (catch-all) | none | USE candidate | Covers a requested group with no specific ladder |
| Per-request fallbacks (`fallbacks` in body) | none | SKIP | Buckle clients never send it; per-fallback prompt overrides exist if ever needed |
| Virtual keys, budgets, spend tracking | Postgres REQUIRED | SKIP (DB-GATED) | Buckle owns auth/keys today. Gotcha: on a DB-less deployment `litellm_settings.max_budget` **fails open** — logs a warning, enforces nothing; virtual keys cannot resolve (`No connected db.`) |
| Key-level rpm/tpm limits | Postgres + Redis | SKIP (DB-GATED) | Per-instance in-memory counters degrade silently when Redis is down |
| Per-deployment `rpm`/`tpm` in `litellm_params` | none | USE | Weighting input for latency-based-routing even single-user |
| Response caching | none for `local`/`disk` | SKIP | Exact-match cache ≈ zero hits on agent traffic; semantic cache documented as unsafe on agentic traffic. Provider-side Anthropic prompt caching is separate and already passes through (W457) |
| `GET /health/liveliness` + `/health/readiness` | none | IN USE | Unauthenticated (verified live: `"I'm alive!"` + `{"status":"healthy","db":"Not connected"}`); the `db` field reports `Not connected` forever on a DB-less deploy — expected |
| `GET /health` | none (key-gated) | USE | Runs a real probe per model — costs tokens; supports `background_health_checks: true` + `health_check_interval` (default 300s), `health_check_max_tokens` (16), per-model `model_info.mode` (`anthropic_messages` for our anthropic rows), `disable_background_health_check` per deployment |
| Request/response logging via custom logger | none | USE candidate | `success_callback` custom class (Python file beside config.yaml); `turn_off_message_logging: True` redacts message bodies if any callback is ever added. No DB/external service needed |
| Swagger/Redoc/OpenAPI surfaces | none | USE (harden) | Env `NO_DOCS=1 NO_REDOC=1 NO_OPENAPI=1` on the litellm spawn kills the schema surfaces — matches the public-stack perimeter lesson (gates are guard-rails, not boundaries) |
| `litellm_key_header_name` | none | LATER | Moves the key to a custom header if the Authorization header ever collides with the gateway |
| Redis for router/cooldown state | Redis | SKIP | Single instance; docs: only for multi-deployment load-balancing state |

`allowed_openai_params` (in use on the zai rows) and per-deployment
`max_retries` are not covered by the staged pages — current values left
untouched. `/v1/models` auth requirements were not verifiable from the
staged pages; through the buckle front those endpoints are not exposed
at all.

## Work items minted

Minted via `work add` at review close (titles verbatim):

1. **Restore fallback ladders on live :4100** — re-run
   `bun bin/gateway-config.ts` from belt with the current policy, reload
   :4100 between fan-outs, then verify `litellm_settings.fallbacks` in
   the generated file. Also reconcile the `litellm_num_retries: 0`
   generation-time state (F1).
2. **Fallback drill asserts ladders are loaded** — extend
   fallback-drill/keepwarm to fail when the live config lacks
   `litellm_settings.fallbacks` (a config assertion, not only the
   dark-path exercise that let F1 sit 12 days) (F2).
3. **Extend fallback ladder coverage + context-window fallbacks** —
   policy rows for `zai-glm-*` twins and `local-swarm` (never `flashx`,
   per owner directive), plus `context_window_fallbacks` with
   `router_settings.enable_pre_call_checks: true` (F3 + surface 3).
4. **Buckle bridge feature-parity decision** — cross-dialect hops drop
   `response_format`/json_schema and stream reasoning deltas and
   synthesize `max_tokens: 4096`; owner decides translate-vs-reject
   policy per field (F4–F6).
5. **Harden the :4100 litellm spawn** — `NO_DOCS`/`NO_REDOC`/
   `NO_OPENAPI` env in `litellm-target.ts`; optionally
   `background_health_checks` + per-model `mode` rows (surface 3).
