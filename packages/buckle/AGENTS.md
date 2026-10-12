# buckle

LLM router plane: dual-dialect pass-through with a NATIVE
dialect-translation tier (W426 — anthropic<->openai body/SSE translation,
both directions, streaming included; pass-through-first: same-dialect
hops rank first), adapters, routing laws, governance, knowledge aids.
Companion of belt (fleet) + suspenders (control plane). Design docs
live in suspenders `docs/design/buckle/`.

## UI law

NEVER `innerHTML` / `document.write` (blocked by the write-gate).
`document.createElement` only inside web components (lit). UI = Lit
components + design tokens per klh-core-components / klh-lit-dev skills.

## Cache boundary law (W458.4)

A cache boundary is `(provider, tenant, region, model)` — `src/cache-boundary.ts`
is the only definition; matching requests reuse provider cache ONLY inside one
boundary, and a present cache entry never guarantees a hit (routing + expiry
decide). Tenant comes from the credential (the `api_key_env` NAME — OpenAI org,
Claude workspace), never from request text; keyless local deployments carry the
URL origin as their telemetry tenant. Cache keys are routing/accounting aids,
NEVER authorization: prefix-affinity steering may not change the ride boundary
(`rideGateKeyOf` — account, region, family, model); collapsing tenant boundaries
for cache savings is refused by construction. Per-lane telemetry: attributed
lanes append NDJSON rows (lane, boundary, usage) to `<db>.lane-cache.jsonl`
(`BUCKLE_LANE_CACHE_LOG` overrides); the ledger stays the durable accounting.
