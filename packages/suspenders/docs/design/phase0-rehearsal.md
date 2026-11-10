# Phase 0 rehearsal — local two-Buckle APIM test bed (W2968)

The local rehearsal for the Azure APIM pilot's Phase 0. A four-service
Compose stack proves the end-to-end contract on the local machine (Docker
Desktop as the simplified test bed) — the real APIM is validated in the
live Phase 0 exit test only.

## Topology

```
host client → apim-sim (edge stand-in) = APIM policy sim: bearer gate,
quota (429 + Retry-After), correlation mint, raw stream passthrough
  → edge-buckle (phase0-edge): upstreams-edge.json + tier-policy-edge.json
  → inner-buckle (phase0-inner): upstreams-inner.json + tier-policy-inner.json
  → stub (vLLM sim, W2969 testbed): STUB_TOKEN gate + /__log journal
```

ONE published port: loopback-bound, dynamic, on apim-sim only. Everything
behind it sits on an internal network and publishes nothing.

## Files (deploy/phase0-rehearsal/)

| File | Role |
| --- | --- |
| `compose.yaml` | The four-service topology (digest-pinned bun, hardened, source-mounted) |
| `apim-sim.ts` | The APIM policy stand-in (pure-Bun, no external imports — container contract) |
| `verify.ts` | Orchestrator: fixture env → compose up → staged mints → checks → teardown |
| `upstreams-edge/inner.json` | Per-hop pools: `test-model` row, provider `fixture-edge`/`fixture-inner`, edge row `buckle: true` (relay leg) |
| `tier-policy-edge/inner.json` | Per-hop fixture tier classes (see below) |
| `buckle-prefs.json` | Test-only prefs (`allow_cloud: true` unlocks Docker-DNS hops) |

## Why a tier policy fixture class per hop

Buckle's account boundary (W1265.1) is a MANDATORY default: absent operator
config, every NAMED key resolves the default `general` class whose provider
allowlist is zai/openrouter only — any other provider scopes the selection
to zero (503 `buckle.tier_no_upstream`), including this rehearsal's rows.
The rehearsal ships explicit per-hop policy files bound to the minted key
NAME `phase0-verify`: class `phase0-*-fixture`, tier `fixture`,
`general: true` (no repo claim), providers `fixture-edge`/`fixture-inner`,
groups `test-model`. The real account boundary stays ON (never disabled);
the fixture classes just make the fixture rows reachable. Discovered in
the independent scoped witness run (2026-11-10); the edge row also needs
`buckle: true` (the relay leg) for the two-named-hop outage trace.

## Staged bring-up (the tmpfs-DB law)

Buckle state lives on the container tmpfs — recreating an issuer after its
mint wipes the DB and the issued key with it. verify.ts stages:

1. `compose up` (fixture env, random secrets, 0600 fixture file)
2. readiness poll (`/__health` at the published port, 120s)
3. mint `EDGE_INNER_KEY` on inner → rewrite env (0600) → recreate edge
   (`--force-recreate --no-deps`)
4. mint `APIM_EDGE_KEY` on edge → rewrite env (0600) → recreate apim-sim
5. checks → revoke minted keys (HTTP 200 asserted) → `compose down` →
   rm fixture dir

No issuer is recreated after its mint: inner is minted once and never
touched again; edge is recreated BEFORE its own mint; the sim holds no
issuer state. `--keep` skips teardown for debugging.

## The checks

1. **discovery** — `/v1/models` through the full chain lists `test-model`
   (edge discovery binding filters by the class groups).
2. **stream** — SSE unbuffered; `include_usage` terminal frame (choices
   `[]` + usage); sim-minted `x-klh-request-id` on the response; NO
   `x-klh-hop-contract` header anywhere on the wire.
3. **identity** — invalid bearer → 401 with ZERO upstream completions
   (stub journal count unchanged — the sim gate refuses before proxying).
4. **surface** — `/v1/admin/keys` + `/__log` are 404 AT THE PUBLISHED
   PORT (excluded faces never publish).
5. **outage** — stop the stub → verbatim 502 whose `fleet_trace.hops`
   name BOTH `phase0-edge` AND `phase0-inner`; then the stub restarts and
   the chain recovers WITHOUT any buckle recreation.
6. **correlation** — client-forged ids AND client-forged traceparent are
   stripped; the sim mints one trusted W3C traceparent per request; the
   response carries `x-klh-request-id` + `x-klh-trace-id`; the trace id
   survives both buckles into the stub journal (`traceId` field) —
   verify joins response trace id === journal trace id.
7. **revocation** — both scoped mints revoke with HTTP 200.

## Correlation plane: trace id, not request id

The buckle relay carries W3C traceparent child spans and does NOT relay
the APIM `x-klh-request-id` upstream (source: proxy-ingress.ts accepts a
caller traceparent or roots a fresh trace; the relay leg stamps
traceparent). The rehearsal therefore joins on the trace id: the sim
strips inbound `traceparent`/`tracestate`, mints
`00-<32hex>-<16hex>-01` (hyphens stripped before slicing), echoes the
trace id on the response as `x-klh-trace-id`, and verify joins that id
against the stub journal's `traceId` capture. `x-klh-request-id` remains
client-facing metadata only. Proven live by the independent scoped
witness (2026-11-10).

## The stub interface (W2969)

verify.ts reads the stub's `/__log` journal via `compose exec` (internal
network only — the journal never publishes). The journal entry carries
`traceId` (nullable) — the inbound traceparent's trace id — alongside
`requestId`. verify stays BLOCKED (exit 3) until W2969 (the vLLM stub
with the `traceId` capture) merges.

## Run

```sh
cd packages/suspenders/deploy/phase0-rehearsal
bun verify.ts          # exit 0 all-pass · 1 fail · 3 blocked (no Docker / no W2969 stub yet)
bun verify.ts --keep   # leave the stack up for debugging
```

## Credential separation

Four distinct credentials, four boundaries: client→sim `APIM_AUTH_TOKEN`
(fixture, random per run), sim→edge `APIM_EDGE_KEY` (minted on edge at
bring-up, name `phase0-verify`), edge→inner `EDGE_INNER_KEY` (minted on
inner, name `phase0-verify`), inner→stub `STUB_TOKEN` (fixture). The
client's developer bearer STOPS at the sim; the edge hop rides the scoped
minted key (READ_/WRITE_ scopes, 600s expiry). Keys are revoked at
teardown (asserted) and the 600s expiry bounds any teardown miss inside
an ephemeral tmpfs DB that dies with the stack.
