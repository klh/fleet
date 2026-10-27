## buckle

LLM router plane: dual-dialect pass-through with a NATIVE
dialect-translation tier (W426 — anthropic<->openai body/SSE translation,
both directions, streaming included; pass-through-first: same-dialect
hops rank first), adapters, routing laws, governance, knowledge aids.
POST /v1/responses (W912): the OpenAI Responses ingress — third path on
the openai dialect, path forwarded verbatim (a responses-only model is
never re-targeted at chat completions; other-dialect hops are
structurally ineligible).
Companion of belt (fleet) + suspenders (control plane). Design docs
live in suspenders `docs/design/buckle/`.

## Account policy (W1265.1) — repo/tier boundary at ingress

The authoritative repo→account-class→tier boundary rides the W1265 named
ingress seam. Config-over-code: `~/.claude/local-llm/repo-tier-policy.yaml`
(`BUCKLE_REPO_TIER_POLICY` overrides; `accountPolicyPath` server opt).
Absent config = inert (logged at boot); a CONFIGURED path
that fails to load is startup fatal (fail closed).

- **Binding axis**: the credential's mint NAME (trusted installer/launcher
  `fleet-ikea-*` vs `fleet-personal-*`) + an optional verified
  `x-klh-repo` claim. A client-supplied repo header alone is never identity
  — spoof = 403 `buckle.repo_claim_mismatch`; key outside every class = 403
  `buckle.repo_unknown`. Decisions audit with a SAFE repo hash (16-hex of
  class+binding — the path never lands), tier, key name.
- **Enforcement**: 403 `buckle.tier_entitlement` (group outside the class
  groups) and 503 `buckle.tier_no_upstream` (no entitled row after scoping)
  both fire BEFORE routing with zero outbound. The scoped selection is
  marked (`accountScoped`) and the router's gatedLadder confines its
  tierCandidates pull to that set — fallback rungs never cross the class
  boundary (the cross-boundary e2e proves zero foreign outbound).
- **Simple disable**: remove/rename the policy file (or unset the env) and
  reboot — the engine logs inert and the gateway behaves exactly as
  pre-W1265.1.

## Schema law

Every `/v1/admin/*` POST body safeParses through the named zod schemas in
`src/gov/admin-schemas.ts` — never a hand `as Record<string, unknown>`
cast (root AGENTS.md, Schema law; W1238.4). New wire-facing bodies add a
schema there first, then consume `adminBody(read.body, Schema)` in the
route.

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

## Gate cache emission (W768)

The gate emits cache_control post-selection where the upstream honors it:
anthropic-family rows get `alignForUpstream` (belt packets realign; otherwise
only bodies with NO client-placed markers are marked — client placement is
never rewritten, and anthropic caps breakpoints at 4). openai-compat rows
never receive markers: ZAI context caching is prefix-implicit (litellm drops
anthropic fields in the body rebuild) and copilot is unknown. Bridged hops
strip markers in the body rebuild (adapters/tools.ts).
`aids.cache-align.default: "off"` in routing-policy.yaml is the operator
kill switch.
