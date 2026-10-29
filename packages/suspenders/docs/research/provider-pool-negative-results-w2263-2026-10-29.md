# Provider-pool negative results — W2263 (2026-10-29)

The incident record and refusal log for configurable provider-pool
capacity (`fleet_loop.provider_pools`). Law: production concurrency only
rises after a stage's matched live load test passes; every refused or
failed stage lands here FIRST. Ceilings are configured MAXIMA, never
proven throughput.

## Incident 2026-10-29 (pre-W2263 baseline) — the negative result

- Configured `provider_pools.zai-coding-account.concurrency = 50`
  (buckle routing-policy) while only ~15 lanes + interactive traffic
  generated sustained 429s (`RateLimitError ZaiException`, 11:25 UTC;
  17 interactive 429s in 5 min; review lanes 429'd all morning).
- W2260 died after ten 429/503 retries with ZERO output — productive-lane
  loss while the process stayed "live". Claimed ≠ productive.
- **Conclusion**: the configured 50 was never capacity. No number in
  `provider_pools` was measured. Start from the incident floor, not the
  config.
- All 14 ZAI litellm rows share ONE key/account (fingerprint
  f63a220e4b) and the api.z.ai coding endpoint — 8 lanes per alias would
  have meant 8×14 = 112 booked against one account. Pools collapse
  aliases via `quota_pool_id`; hub multiplicity adds nothing.

## Configured ceilings vs. proven stages

| pool key | configured ceiling | proven concurrent | evidence |
| --- | --- | --- | --- |
| zai-coding-account | 50 (old policy) / TBD in stack.json | NONE — 429s at ~15 lanes + interactive | incident 2026-10-29 |

Fill a row per pool per PROVEN stage (ramp plan
`hooks/lib/fleet-loop/pool-ramp-plan.ts`, stages 25/50/75/100% of the
automatic ceiling). A stage is proven only by a matched live load test
during a quiet window: no provider 429, no review/interactive
starvation, lanes productive (output, not process liveness).

## Stage log (append, never edit)

| date | pool | stage (lanes) | verdict | evidence / why refused |
| --- | --- | --- | --- | --- |
| 2026-10-29 | zai-coding-account | any raise | REFUSED | interactive + review traffic 429ing; operator set 30-min dispatch hold to 12:05 UTC; no load probes allowed |

## Operator runbook

1. Quiet window (no dispatch hold, interactive traffic low).
2. Build the plan: `bun -e` import `pool-ramp-plan.ts`, print stages.
3. Run `capacity-ramp run --route <stageRouteArg(stage)>` dry first,
   then `--live` for the stage's lane count ONLY (never above it).
4. Green → append the proven row above, then raise the configured
   ceiling by at most one stage. Red → append the refusal and STOP.
