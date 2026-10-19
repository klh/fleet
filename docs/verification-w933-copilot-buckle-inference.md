# W933 — Copilot inference through Buckle: verification record (2026-10-19)

Verifies W920's Copilot route configuration against the live buckle spoke
(:4101) with scoped lane credentials (`bksk_` proxy-WRITE key, lane front
`/w/<sid>`). Mission: prove one call per endpoint shape with explicit cloud
route, classify failures, surface honest readiness — never claim config as
proven inference.

## Verdict

**Config proven routeable. Inference NOT proven.** Every shape was driven to
a classified terminal state; no completion token was returned by the seat.

## Method

- Client: lane-shaped POSTs through the scoped buckle front
  `http://127.0.0.1:4101/w/<sid>` with `x-belt-hint: must cloud` (the only
  leg that reaches a cloud-only group — a pinned explicit-model call
  no_routes at attempts=0 by the pinned-cloud gate, W695.6.2).
- Evidence: route_audit rows (spoke ledger `~/.claude/local-llm/buckle.db`),
  spoke log `~/.claude-insights/buckle-spoke.log`, direct-seat diagnostics
  (labeled direct — not buckle proofs) for path-shape confirmation.
- Auth material: `GITHUB_COPILOT_PAT` present in spoke env (buckle-spoke.env,
  40 chars); zero 401/403 observed on any leg.

## Results per endpoint shape

| Shape | Model | Result | Classification |
| --- | --- | --- | --- |
| `/v1/messages` | claude-sonnet-5 | 429 `rate_limit_error`, retry-after **1058256s (~12.2 d)**, after 61s | quota wall — wire reached the seat, relayed post walk-sleep |
| `/v1/responses` | gpt-5.3-codex | 429, retry-after 1058196s, after 61s | quota wall — verbatim path forwarding reached the seat |
| `/v1/chat/completions` | gpt-5.4 | 502 no_route — Copilot returned **404**, 161ms | adapter path-shape bug (below) |

- The 61s before the 429 relay = the walk's floor-capped retry sleep
  (60s `retry_after_cap_s` + jitter, W695.6.1) — the cap works: the walk
  sleeps a minute, not the provider's 12 days, then relays.
- No-hint calls: `502 no_route` at 4ms, zero candidates attempted —
  pinned-cloud gate behavior, by design, NOT a config failure.
- Direct-seat cross-check: `api.githubcopilot.com/chat/completions` → 429
  quota (path served); `/v1/chat/completions` → 404 (path not served).

## Chat-shape path bug (follow-up minted)

`openai-compat.buildCall` forwards the ingress path verbatim
(`new URL(req.path, dep.url)`, openai-compat.ts:41) — buckle posts
`https://api.githubcopilot.com/v1/chat/completions`, but the Copilot chat
wire lives at `/chat/completions` (no `/v1`). Broken for every openai row
regardless of quota; `/v1/responses` happens to be served with the `/v1`
prefix, which masked the bug on that shape. W684's 2026-10-12 tool_calls
proof predates the verbatim-forwarding change (or rode a no-prefix path).

## Honest readiness per model (23 configured, one shared seat)

- **All 23 models**: routeable (must-cloud hint reaches the Copilot wire),
  auth OK, catalog-loaded (35 groups on the spoke, 23 Copilot rows) —
  and **quota-walled seat-wide until ~2026-10-31** (retry-after ~12.2 d
  from 2026-10-19).
- Shape matrix (catalog-derived, belt `/api/model-access`): claude-* →
  `/v1/messages` + `/chat/completions`; GPT/grok/mai → `/responses`
  (gpt-5.4, gpt-5-mini also `/chat/completions`); gemini-* → `/responses`
  only.
- Per-model inference status is uniform: **not proven** until the seat wall
  lifts; re-run `bin/copilot-seat-proof.ts` (or this shape probe) after
  ~2026-10-31.
