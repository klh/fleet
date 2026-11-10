# Phase 0 rehearsal testbed — inner Buckle arm

Owner-directed Phase 0 rehearsal (consults C380/C382/C384, three lanes READY):
the on-prem model route rehearsed locally with deterministic stand-ins
instead of a GPU. Chain under rehearsal:

```
developer client -> APIM-policy stand-in -> edge Buckle -> inner Buckle -> vLLM stub
```

Ownership: this directory + `test/phase0-rehearsal.e2e.ts` are the inner-Buckle
arm (stub, contract rows, test matrix). The compose wiring, the edge
APIM-policy stand-in and the verify orchestrator are the edge arm (fleet
flash, coordinated through C384 deltas). Real APIM / GPU / private
networking stay OUT — they are live checks on real hardware later.

## The stub (`vllm-stub.ts`)

A deterministic OpenAI-compatible stand-in for vLLM. No model, no weights,
loopback-only, dependency-free:

- `GET /v1/models` — one served id (`test-model` by default), Bearer-checked.
- `POST /v1/chat/completions` — JSON and SSE. Content is deterministic
  (`stub-ok`); `pace_ms` in the body paces SSE frames (default 40ms, clamped
  0–2000) so pacing regressions are observable, not jitter-guessed.
- SSE semantics follow OpenAI: paced `chat.completion.chunk` frames, and a
  terminal usage frame (`choices: []`) ONLY when the caller sent
  `stream_options.include_usage`. The inner Buckle always injects
  include_usage on streamed chat completions — so through-gate streamed
  requests must produce the usage frame. The journal records what each
  request actually carried, making the injection provable rather than
  assumed.
- `GET /__log` — the rehearsal journal: per request, arrival order, key
  fingerprint (sha256-16 of the bearer), the request-id headers EXACTLY as
  received (null when absent, never synthesized), stream/include_usage
  flags, chunk count, pacing. This is the terminal hop for correlation and
  header-strip assertions.
- Denial is real: a missing or wrong bearer is a 401
  `invalid_request_error/invalid_api_key`.

Run standalone: `bun run deploy/phase0-testbed/vllm-stub.ts` is not an
entrypoint — the stub starts via `startVllmStub()` from the e2e spec or a
compose service command (`bun run deploy/phase0-testbed/vllm-stub-main.ts`
style wrapper is the edge arm's wiring decision).

## Inner-Buckle contract (`upstreams.testbed.json`)

- `inherit_defaults: false` — LOAD-BEARING: the pool is exactly the one row
  below; no committed ladder merges underneath, so fail-closed with zero
  fallback is structural, not policy.
- Single group `test-model` → `http://stub:8190/v1` (compose-internal
  hostname; the e2e writes its own temp rows with dynamic ports and does
  NOT read this file).
- `api_key_env: STUB_TOKEN` — names an env var read at request time; the
  value never lives in any committed file.
- Inner-Buckle env law: `BUCKLE_AUTH=on` (default) and `BUCKLE_BIND=0.0.0.0`
  inside the container. The gate refuse-to-boots a non-loopback bind without
  the governance gate — that refusal IS the private-bind rehearsal; never
  bypass it.

## Credentials (three, none crossing a hop boundary)

| Hop | Credential | Lifetime |
| --- | --- | --- |
| client → APIM stand-in | test bearer | compose-up, torn down after |
| edge Buckle → inner Buckle | `bksk_` key minted from the inner Buckle admin API at up | revoked at teardown; the revocation receipt is the cleanup evidence (W2932 pattern) |
| inner Buckle → stub | `STUB_TOKEN` env | compose-up only |

## Correlation

The edge mints `x-klh-request-id`; client-supplied request ids are stripped
at the edge. Assert the id lands in the edge stand-in log, the inner Buckle
ledger row, and the stub journal. Do NOT stamp `x-klh-hop-contract`
(W1086) in this chain — it carries Fleet-internal deadline/budget semantics
this rehearsal must not fake. The stub-side strip assertion: a client-forged
id sent THROUGH the gate must arrive as `requestId: null` in the journal
(buckle forwards no client headers upstream), while the same id sent DIRECT
to the stub arrives verbatim — proving the strip happens at the gate, not
because the stub ignores headers.

## Test matrix (`test/phase0-rehearsal.e2e.ts`)

Dockerless (ports are ephemeral; the gate boots in-process via
`startServer`): discovery, JSON completion, paced SSE through the gate,
include_usage-injection proof (direct-without vs through-gate-with), 401 at
the gate, zero-fallback on stub outage + recovery without a gate restart,
header-strip correlation, revoked-key denial. The compose smoke on Docker
Desktop rides the same matrix via the edge arm's verify script.

## Compose wiring (edge arm — placeholder)

The compose file is NOT in this directory yet; when the edge arm lands it,
it provides: a distinct compose project name (e.g. `phase0-rehearsal`),
one internal network with the four services (client is run ad hoc, not a
service), ONLY the edge port published (free-picked at up-time), resource
caps (buckle 512m / 256 pids, stub and stand-in smaller), and no
`x-klh-hop-contract` stamping. Contract inputs it consumes from here: the
stub service (this directory, port 8190 on the internal network) and the
upstream rows file above mounted read-only at the inner Buckle's
`BUCKLE_UPSTREAMS` path.
