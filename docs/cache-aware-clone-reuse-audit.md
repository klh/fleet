# Cache-aware clone reuse — audit (W901)

Audit date 2026-10-19. Question: are configured model routes cache-aware
for lane/session clone traffic — stable prefixes, routing affinity, and
honest per-route capability marks — and what does warm vs cold actually
cost? Method: live probes through the real chain (spoke :4101, local swarm
:8902), the per-lane cache telemetry log, and the machine-level runtime
config snapshot (read-only, tenant = credential env NAME per the boundary
law, no values). Companion to the W499 litellm-behind-buckle review.

## 1. Active inventory (snapshot 2026-10-19)

Buckle groups (machine `~/.claude/local-llm/upstreams.yaml`, 16:00) —
every cloud row rides the :4100 litellm engine, locals ride :890x MLX
direct; no direct api.anthropic.com / Copilot rows are active:

| buckle group | deployments (dialect → rung) |
| --- | --- |
| glm-5.3-flash | :4100 openai (zai-glm-5.3-flash) → :4100 anthropic (glm-5.3-flash) → :8902 mlx |
| local-swarm | :8902 mlx direct → :4100 tiers |
| local-coder / local-reason / local-general | :4100 → MLX :8901/:8903/:8906 |
| zai-glm-5.3-flash / 5.3 / 5.2 | :4100 openai + anthropic rows |
| claude-sonnet-5, claude-opus-5-5, claude-haiku-4-5, claude-sonnet-5-5, claude-haiku-5-5, claude-opus-4-8, claude-opus-5, claude-fable-5-1 | alias → :4100 anthropic, `model: zai-glm-5.3-flash` (Copilot ladder bottom, quota-walled rows removed) |
| gpt-5.2 | :4100 → api.openai.com (dormant, no OPENAI_API_KEY verified) |

LiteLLM :4100 (`litellm.yaml`, generated 14:49Z): 16 model groups —
4 local-* (MLX :890x), nas-qwen2.5-0.5b (ollama :11434), 4 zai-glm-* and
3 glm-* (api.z.ai, openai and anthropic wires), claude-sonnet-5 +
claude-haiku-4-5 (api.anthropic.com), local-swarm (:4000), gpt-5.2.
Ladders live under `litellm_settings.fallbacks` (glm → zai twin →
local-reason) — the W499 F1 stale-activation gap is closed as of this
generation.

## 2. Cache semantics per route — verified live

| route (tenant) | prefix cache | cache reported | evidence |
| --- | --- | --- | --- |
| ZAI anthropic wire — `anthropic/glm-*` via :4100 (LITELLM_KEY) | yes — explicit `cache_control` honored, implicit otherwise | yes — `cache_read_input_tokens` | probe 2026-10-19: #1 0 (creation), #2/#3 `cache_read 1152`; telemetry week hit 0.904 over 393.6M tok |
| ZAI openai wire — `zai/glm-*` via :4100 (LITELLM_KEY), incl. the claude-* alias after litellm's anthropic→openai translation | yes — prefix-implicit | yes — `cache_read_input_tokens` surfaced in the anthropic-shaped rebuild | probe: claude-alias #2/#3 `cache_read 1152`; telemetry hit 0.965 over 91.5M tok |
| api.anthropic.com direct (ANTHROPIC_API_KEY) | yes — explicit, ≤4 breakpoints, 5-min TTL | yes | telemetry `claude-fable-5-1` hit 0.898 |
| GitHub Copilot seat (GITHUB_COPILOT_PAT; rows retired) | yes — prefix-implicit | yes — anthropic-shaped fields | telemetry while active: hit 0.684 (1173 req) / 0.735 — supersedes the W768 "copilot unknown" mark with observed evidence |
| MLX local swarm :890x rapid-mlx (keyless, origin tenant) | yes — in-process prompt/KV cache | yes — `prompt_tokens_details.cached_tokens` | probe: #1 0, #2/#3 `cached_tokens 1261`, TTFT 652→383 ms |
| litellm → ollama nas qwen2.5-0.5b | limited — in-process KV under keep_alive only | NO — no cache fields | config shape; marked unsupported-reporting |
| OpenAI gpt-5.2 (dormant) | yes — automatic ≥1024-tok prefixes | yes — `cached_tokens` | documented provider semantics, NOT live-verified — marked unverified |

Cross-dialect reporting note: W499 F4 records translated hops dropping
cache usage. Live probe today refutes the cache-usage clause for the
buckle→:4100-zai leg — `cache_read_input_tokens` comes back reported.
F4's response_format / reasoning-delta clauses are untouched by this
audit.

## 3. Clone inheritance + affinity chain — enabled

The chain a lane clone rides, every link verified on the live path:

1. **Stable prefix**: dispatch forks lanes from the starter session
   (mother-clone), so sibling lanes share byte-identical orientation
   bytes — the W894 savings plane measures this (86 of 89 fleet-day
   lanes forked; STARTER_SAVED_TOKENS 9332/lane, 2026-10-07 bench).
2. **Affinity**: buckle's W237 `PrefixAffinity` (src/affinity.ts) binds
   the packet-block hash → candidate id (TTL 300s, LRU 4096) and reorders
   the selection onto the bound candidate — never across a ride boundary
   (W458.4 `rideGateKeyOf` guard). Wired live: handlers.ts:382,421.
3. **Gate cache emission**: W768 `alignForUpstream` places the
   `cache_control` breakpoint after the packet block on anthropic rows
   (aids-routes.ts); openai-compat rows stay marker-free (prefix-implicit).
4. **Telemetry**: `LaneTelemetryLog` appends per-lane rows to
   `<db>.lane-cache.jsonl` (server.ts:138) — the accounting plane.

Enablement state: all three planes ride DEFAULTS — no
`BUCKLE_AFFINITY=off`, no cache-align kill switch in any runtime env
(checked by name 2026-10-19); `aids.cache-align.default: on` in the
committed routing-policy.yaml; the runtime policy copy carries no aids
override. Nothing needed flipping.

## 4. Warm vs cold — measured

Micro probe (1.2k-tok stable prefix, glm-5.3-flash through :4101,
2026-10-19): cold call reports 1171 input tokens; warm calls report
19 input + 1152 cache-read. At a 0.1× cache-read price factor that is
~134 billed-equivalent input tokens per warm call vs 1171 cold —
**≈88.5% input-cost reduction per warm call**. TTFT on the cloud flash
tier is flat at this prefix size (1.0–1.4 s); the local MLX tier shows
the latency win directly (652→383 ms).

Fleet telemetry (`buckle.db.lane-cache.jsonl`, 2026-10-12 → 10-19):
37,511 requests, 593.7M input tokens, 445.8M cache reads —
**75.1% hit share**, ≈67.6% input-cost saving vs all-cold at 0.1× reads /
1.25× writes. Per route: glm-5.3-flash 90.4% (30690 req — the workhorse),
zai-glm-5.3-flash 96.5%, anthropic-direct fable 89.8%, Copilot 68.4%
(while active). 61 of 293 attributed lanes recorded cache reads — the
unattributed remainder is NOT cold lane work: per the W900 classification
(cca0ce2b) it is bare-ingress synthetic readiness probes (root key, plain
/v1/chat/completions, no lane — NAS qwen2.5:0.5b 1/min, desktop
zai-glm 1/min), counted separately from agent cache-miss traffic.

Anomaly on record: 2026-10-12, the Copilot quota-wall day, the
claude-sonnet-5 boundary rode 100.0M input tokens over 1409 requests at
0.1% hit — fan-out thrash while the alias ladder re-bottomed. Post
Oct-14 the same boundary rides warm (0.517 on its small residual). No
current action.

## 5. Explicit capability marks

- nas ollama (qwen2.5-0.5b): cache reuse limited to process-local KV;
  NO usage reporting — treat as always-cold for accounting.
- gpt-5.2 row: dormant; caching semantics documented, not verified on
  this stack — do not claim savings until probed.
- Copilot rows: retired from the machine config (quota wall) — semantics
  recorded above for the ladder's return.
- openai-compat rows never receive cache_control markers (W768) — their
  caching is prefix-implicit and depends on byte-stable prefixes, i.e.
  on the affinity/starter chain holding.
- W622 resume-from (lane resume prefix stability): not audited here —
  no lane-resume probe was run; resume traffic classification rides the
  W900 fix. Untested surface, no claim made.

## 6. Findings

1. The enablement ask is already satisfied by W237 + W458.4 + W768 +
   W894; this audit verifies each link live and finds no open kill
   switch. No config or code change required.
2. The residual cold risk is the one F2 exposed for ladders: nothing
   ALERTS on cache-share regression. The drill proves gateway-up, not
   cache-warm — a silent degradation (affinity off, prefix drift, a
   non-caching rung on top) would surface only in this jsonl.
