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

Run standalone: `startVllmStub()` from the e2e spec, or the compose
entrypoint `bun run deploy/phase0-testbed/vllm-stub-main.ts` (edge arm's
wiring): env `STUB_HOST` (default loopback; compose passes `0.0.0.0` so
peer containers on the internal bridge reach the service-name route),
`STUB_PORT=8191`, `STUB_TOKEN` (the inner Buckle's `api_key_env` reads the
SAME var), optional `STUB_MODEL`. No published port — the stub is
reachable only inside the rehearsal network, `/__log` included.

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

## Credentials (four, none crossing a hop boundary)

| Hop | Credential | Lifetime |
| --- | --- | --- |
| client → APIM stand-in | test subscription key/bearer | compose-up, torn down after |
| APIM stand-in → edge Buckle | stand-in bearer for the APIM policy tier | compose-up, torn down after |
| edge Buckle → inner Buckle | `bksk_` key minted from the inner Buckle admin API at up | revoked at teardown; the revocation receipt is the cleanup evidence (W2932 pattern) |
| inner Buckle → stub | `STUB_TOKEN` env | compose-up only |

## Routing-classification reality (01a186a5 Docker proofs #121222–#121230)

Compose service-name routes classify as CLOUD by the gate's residency
classifier (`kindOfHost` knows only loopback as local) — the rehearsal is
single-network with zero real egress, so the test-only posture is either
`BUCKLE_PREFS` with `allow_cloud:true` (isolated internal bridge keeps it
safe) or, preferred, explicit residency tags:
`BUCKLE_RESIDENCY_LOCALITY=hub-local` + `BUCKLE_RESIDENCY_REGIONS=pilot`
with matching `BUCKLE_POLICY` tags on the rows. Mismatched residency
advertises the model but answers 503 `no_healthy_fit` with
`X-Klh-Attempts: 0` — that IS the residency denial rehearsal; accept on
inference, never on catalog. The real Azure→private-on-prem boundary still
needs explicit approved routing/residency design before deployment; never
decrease trust from an HTTP allowlist or enable a global cloud fallback.

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

## Transport: HTTP/3 at the edge, durable keep-alive inner hops

Owner directive: HTTP/3-capable chain for durable connections. Runtime
facts (verified 2026-11-10): Bun 1.4.4 `Bun.serve` speaks HTTP/1.1 (+WS) —
no h2/h3 server — and Bun's fetch client is h1; vLLM (uvicorn) does not
serve h3. Caddy (the fleet front, `com.klh-local.caddy`) serves h3 natively
(ALPN h3+h2+h1, Alt-Svc auto-advertised, needs UDP+TCP published).

So the chain's transport matrix is:

| Hop | Transport | Why |
| --- | --- | --- |
| client → APIM stand-in → edge | **HTTP/3 (QUIC)** via the Caddy front on the published port (TCP **and** UDP) | 0-RTT resumption, connection migration, no cross-stream HOL blocking — pays exactly on the client-facing leg |
| edge Buckle → inner Buckle → stub | HTTP/1.1 keep-alive, connections held warm across requests | reliable point-to-point bridge; asserted by the e2e (one TCP socket, sequential requests, no close) |

This is ALSO the production shape: real vLLM never speaks h3, so the
on-prem leg terminates at an h3 front in front of it. True h3 between inner
containers (per-hop Caddy sidecars) would add QUIC handshakes between
trusted peers for zero loss-recovery benefit — rejected; the deviation
(Bun/vLLM h3 servers absent) is recorded here rather than forced. The
Docker Desktop compose must publish the edge port as `443/tcp` **and**
`443/udp` for the h3 leg (Docker Desktop forwards UDP fine at rehearsal
scale); the verify script's h3 probe rides the Caddy container itself (the
macOS system curl has no h3).

## Compose wiring (edge arm — placeholder)

The compose file is NOT in this directory yet; when the edge arm lands it,
it provides: a distinct compose project name (e.g. `phase0-rehearsal`),
one internal network with the four services (client is run ad hoc, not a
service), ONLY the edge port published (free-picked at up-time), resource
caps (buckle 512m / 256 pids, stub and stand-in smaller), and no
`x-klh-hop-contract` stamping. Contract inputs it consumes from here: the
stub service (`deploy/phase0-testbed/vllm-stub-main.ts`, env names above,
port 8191 on the internal network) and the upstream rows file above
mounted read-only at the inner Buckle's `BUCKLE_UPSTREAMS` path. Both
authenticated Buckles need `BUCKLE_BIND=0.0.0.0` + a writable
`BUCKLE_DB` path inside the container (01a186a5 #121222).
