# W1257 — Z.ai pressure, error provenance, and the false-429 chain (2026-10-24)

Item: W1257 · branch `suspenders/W1257` · lane `autow1257-p98b319584008df14`
· E2E evidence commit `3ad5e3fd` (test-first, red pre-fix) → fix commit
`dc4bf382` (green).

Child item **W1257.1** (dispatched separately) owns the Coding-Plan endpoint
guard, `packages/buckle/upstreams.zai.json`, and the catalog endpoint — its
close is referenced, not duplicated, here.

## What broke (chain of custody for the false 429)

| # | Layer | Behavior pre-fix | Evidence |
| - | ----- | ---------------- | -------- |
| 1 | `providerPressureOf` (buckle) | Any configured code (machine config lists 1302) classified **concurrency** → `ProviderAdmissionCore.feedback` collapsed `adaptiveConcurrency` to 1 — on a shared-account RPM-style refusal with **no concurrency evidence in the message** | Live spoke 10:20 CEST: `adaptiveConcurrency=1/50` ceiling, `concurrencyLimitedTotal=940`, `rateLimitedTotal=1192` |
| 2 | `rememberCooledRateLimit` | A bench-window arrival got a **synthetic 429** ("Upstream rate limited; retry after cooldown") with **no provider code/type/message** — a fabricated-429 masquerade | Owner note #67789 (independent confirmation); code `router.ts:1040-1066` pre-fix |
| 3 | W450 in-flight admission | Overflow answered a **local 429** — the provider's budget claimed by the gateway | `handlers.ts` pre-fix; owner requirement 2026-10-24: local refusals are typed local 503s |
| 4 | Trace provenance | `refusal_origin=local-admission` was **NULLed at insert** (ledger whitelist omitted it) — a local answer was not provable in the trace | `ledger.ts:762-766` pre-fix |
| 5 | Wrong endpoint (root cause of the screenshot 1113) | `upstreams.zai.json` rewrote to general `/api/paas/v4` → 429/1113 "Insufficient balance" for a Coding Plan credential | Owner route A/B (#67684): same key, general → 429/1113; coding endpoints → 200. **W1257.1 scope** |

## The fix (evidence-gated classifier + typed local refusals)

| Change | File | Behavior post-fix |
| ------ | ---- | ----------------- |
| Concurrency classification requires `EXPLICIT_CONCURRENCY_EVIDENCE` (`/concurr(ent\|ency\|ing)/i`) in the provider's message, in addition to the configured code | `provider-pressure.ts`, `router.ts` | Generic 1302 "Rate limit reached for requests" paces (rate); the pool window never collapses to 1 on it |
| Bench-window arrivals answer a **typed local 503 hold** naming the gateway cooldown + the provider's last-seen words as attributed context; one local-admission attempt receipt carries the banked tokens | `router.ts` `rememberCooledRateLimit`, `cooldown.ts` | No fabricated 429 survives; retry-after = bench remainder (≤ cooldown_time) |
| Provider rate-limit words banked per deployment at every rate-limit rung | `cooldown.ts` | The hold cites the provider's own code/type/message |
| W450 local admission = typed 503 + Retry-After | `handlers.ts` | "gateway at max in-flight … (W450)" — pinned by the wire e2e |
| `refusal_origin=local-admission` persists | `ledger.ts` | Traces prove which layer answered |

## Synthetic two-Buckle E2E (deterministic, `provider-pressure-e2e.test.ts`)

| Phase | Contract | Pre-fix | Post-fix |
| ----- | -------- | ------- | -------- |
| A | 50 concurrent provider-200 through two real Buckles: all useful, pool gauges at ceiling both hops | pass | pass |
| B | 1302/1311/1113 waves: relayed subset carries the provider's **exact status/code/type/message/retry-after**; every other answer is a typed local 503; pool `adaptive_concurrency=50`, `concurrency_limited_total=0` both hops; trace proves `refusal_origin=upstream` + banked tokens | **fail** | pass |
| B2 | Cooldown bench + dead leg: typed local 503 hold citing "gateway cooldown … not the provider … last provider refusal: code 1302 …"; retry-after ≤ cooldown; **no 429 in the hold window** | n/a (behavior was the fabricated 429) | pass |
| C | Local in-flight overflow (cap 2): zero 429s; refusals typed 503 problem+json | **fail** | pass |

## Live evidence (owner probes; lane ran no live load)

| Probe | Result | Caveat |
| ----- | ------ | ------ |
| Spoke slots 10:20 CEST | collapse signatures above | shared-account, fleet traffic present |
| W1257.1 lane stall | adaptive 2, queued 11 | recovery from collapse is the open operational question |
| Direct Flash 50 stampede (quiet window) | 15x200 / 35x429-1302 | burst-shaped; RPM vs concurrency **unclassified** — aggregate/shared load |
| Direct Flash 10s jitter / 5s paced | 49x200/1x1302 · 47x200/3x1302 | pacing helps but does not prove a fixed per-model number |
| Same-key route A/B | coding endpoints 200 vs general 429/1113 | definitive for the endpoint invariant (W1257.1) |
| glm-5.3 sequential phases | 31/18/1 then 22/28 (1302) | account-shared contamination across phases |

Sources: `finding.zai-load-20261024`,
`finding.zai-flash-quiet-window-20261024`,
`finding.w1257-1-queued-before-first-tool-20261024`; owner notes
#67574/#67590/#67638/#67657/#67744/#67766/#67789.

## Uncertainty kept

- 1302 under shared-account load: request-rate vs concurrency **remains
  unclassified**; the fix does not need the answer (pacing is correct for
  both; collapse only on explicit evidence).
- The historical screenshot's outbound URL is **inference** (#67738): the
  wrong general endpoint is proven in the tracked template + A/B, not proven
  as the historical request path.
- Catalog shows FlashX despite plan-denied 1311 — entitlement ≠ catalog
  listing (W1257.1 / operator follow-up).

## Operator config note (owner-coordinated)

Machine config still lists 1302 in
`~/.claude/local-llm/routing-policy.yaml` + `~/.config/klh/stack.yaml`
concurrency-code rows. With the evidence-gated classifier a bare 1302 entry
can no longer collapse the pool — the config repair is now
**risk-reducing, not urgent**; owner coordinates any change/reload.
