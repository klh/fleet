# Ramp capacity incident 2026-10-22 — account admission and 429 feedback

W1152. Owner-authorized ramp to ~20 live lanes. The hub told the truth
(top-100: 31 HTTP 200, 20 upstream 429, 31 no-candidate 503); the local
top-100 hid the same failure behind fallback 200s. Operator paused the
launcher (SIGSTOP 8499, `.fleet/dispatch-paused`); running lanes continued.

## What the provider actually returned

Z.ai CodingPlan upstream (Anthropic wire): HTTP 429, wire code `1302`,
body "Rate limit reached for requests" (`litellm.RateLimitError:
ZaiException`, litellm trace `ce843765572fc3d993d841c1bc3a4954`). A
capacity limit on the shared account, not an auth or route fault.

## Root cause: attempt amplification at the hub walk

Trace `1252d23afc55a8d355f44b8bb231d6f2`: one client request produced
three provider attempts (15:06:34.181, 36.393, 38.718 — ~2.2 s apart,
matching `retryDelayS` 2^1 + jitter) and then a client 499. The chain:

1. `walkSelected` (packages/buckle/src/router.ts:1067) walks every
   `sel.ordered` row; the flash selection carries two same-account
   terminal rows.
2. Each row runs `attemptTier` with a single candidate
   (router.ts:1119/1127); the loop takes `num_retries + 1` attempts
   (router.ts:661) and a rate-limited outcome under `retry_after_cap_s`
   re-books the SAME row as `pendingRetry` (router.ts:899-906).
3. Hub policy was the repo default `num_retries: 1`
   (packages/buckle/src/policy.ts:144) → one row = up to 2 provider
   hits; two rows = up to 4 per admitted request. Observed 3, then the
   client walked away (499).
4. Feedback is row-keyed: `Cooldowns` keys `group|url`
   (packages/buckle/src/cooldown.ts:63) with `allowed_fails: 3`,
   `cooldown_time: 30`. Two same-account rows let the account absorb up
   to 6 consecutive 429s before ANY bench, and the bench then benches
   rows, not the account — the "31 no-candidates 503" state.

litellm is attempt-neutral on both egresses (`num_retries 0`,
`max_retries 0`, no fallbacks). The hub's own walk is the only amplifier.

## Queue ownership map (before remedy)

- Local spoke (Mac belt :4000): paces OUTER ingress — 2 starts/s, 50
  concurrency, timeout 45 s (4301 calls metered). Paces requests, not
  account attempts; the actual provider 429 path is downstream of it.
- Hub (NAS buckle :4101): rendered `upstreams.hub.yaml` binds NO
  `provider_pool`, so W1078's fail-closed rule means NO admission core
  exists at the real account egress (router.ts:330-345).
- The same CodingPlan account is reachable from two egresses (NAS
  litellm for hub lanes, Mac litellm :4100 for local fallback) with no
  shared state — the provider sees the sum; neither side paces it.

## Remedy contract (config-first; no new admission implementation)

The adaptive shared pacing this contract called for LANDED in the
9a67fdb2 release: `ProviderAdmissionCore` now bends a per-pool adaptive
start gap from real 429 feedback (leases carry
`feedback(status, retryAfterS)` —
packages/buckle/src/provider-admission-core.ts:41-75), deployed at 50
concurrent / 50 starts per 1000 ms. The evidence-backed minimum remains:

1. **One admitted attempt = one provider attempt** at the hub: rendered
   hub policy `num_retries: 0` plus one terminal row per alias (dedupe
   same-account rows). W1152.1 landed the knob: `buckle_gateway:` in
   `~/.config/klh/stack.yaml` per hub → `renderHubPolicy`
   (packages/suspenders/deploy/hub-policy.ts) → mounted
   `/etc/klh/routing-policy.hub.yaml` (W1152.1, result 90235cb5).
2. **Bind the account at its authoritative egress**: `provider_pool` on
   the hub's Zai rows + `gateway.provider_pools` in the hub gateway
   policy — W1078 `ProviderAdmissionCore`
   (packages/buckle/src/provider-admission-core.ts:53), operator-owned
   numbers, fail-closed. Do NOT add a second independent queue
   pretending shared state.
3. **Account-faithful bench for free**: with one row per account, the
   row-keyed bench becomes account-faithful; W1077 probe-before-skip
   (router.ts:1111) re-admits a live row fast.
4. **Single authoritative account egress** (operator decision): local
   cloud fallback rides the hub's admitted egress, or accounts split per
   egress. Needed before any ramp past ~20.

No bypass, no hardcoded exclusion — pacing and admission only.

## Verify under real load, then resume 30-40

1. `hubctl render/push/up/status <hub>`; canary hub first.
2. Probes: `x-klh-provider-pool` + `x-klh-provider-queue-wait-ms`
   (router.ts:442) prove the pool served and separate queue dwell
   from provider latency; hop receipts show ≤ 1 attempt per request at
   the account hop.
3. Acceptance: hub top-100 zero upstream-429 at steady state; 503s only
   with an honest retry-after; queue-wait absorbs bursts.
4. Operator lifts SIGSTOP/`dispatch-paused`; ramp 10 → 20 → 30-40 with
   probes green at each step. Upstream-429 reappearing = hold, feed
   retry-after into the pool policy (never widen the ladder).
