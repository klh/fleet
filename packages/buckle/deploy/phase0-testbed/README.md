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
(Bun/vLLM h3 servers absent) is recorded here rather than forced.

h3 probe tools on this Mac (verified 2026-11-10): Homebrew curl 8.23.0
(`/opt/homebrew/opt/curl/bin/curl`, ngtcp2/nghttp3) — live h3 proven
against the real internet (`--http3-only`, `proto=3`); xh 0.26.3 has NO h3
(the `--http3` flag is rejected); Apple system curl has no h3.

## Compose wiring (edge arm — LANDED, smoke receipt below)

`docker-compose.yml` in this directory builds the full chain on one
internal bridge — host → caddy (`:8443/tcp+udp`, the ONLY published
ports) → gate-edge → gate-inner → stub. Nothing else is published; the
stub and its `/__log` are reachable only from inside the network. The
worktree root mounts read-only at `/fleet` so the `@klh/*` workspace
symlinks resolve inside the mount; every bun service does
`cd /fleet/packages/buckle && exec bun run …`.

Compose-specific knobs discovered by the smoke (all lawful env surfaces,
all recorded here for the fleet-flash handoff):

- `BUCKLE_HTTP_UPSTREAM_HOSTS` — the plain-http upstream guard refuses
  compose service names (`stub`, `gate-inner`); each gate lists its own
  neighbour there.
- `BUCKLE_PREFS` → `prefs.testbed.json` (`allow_cloud: true`) — compose
  names classify CLOUD (`kindOfHost` knows only loopback as local), so
  the rehearsal bridge opts into the documented test-only posture. The
  refusal path (`503 no_healthy_fit`, zero outbound) stays covered by the
  residency e2e with `allow_cloud: false`.
- `BUCKLE_REPO_TIER_POLICY` → `account-policy.testbed.json` — the account
  boundary stays LIVE (W1265.2 never-inert): exactly the two testbed row
  providers (`buckle-inner-testbed`, `vllm-testbed`) are entitled;
  anything else hits the typed `tier_no_upstream` refusal — a rehearsal
  receipt in its own right.
- TLS at the edge: a self-signed pair minted into `.smoke-certs/`
  (git-ignored, EC P-256, 7 days) and mounted into Caddy —
  `tls internal` cannot issue for a bare-port site address.

Run (from this directory):

```sh
docker compose up -d
docker compose up --exit-code-from verify verify   # PHASE0_SMOKE_OK 11 checks
/opt/homebrew/opt/curl/bin/curl -sk --http2 \
  -o /dev/null -w 'proto=%{http_version} status=%{http_code}\n' \
  https://localhost:8443/v1/models -H "authorization: Bearer $EDGE_ROOT_KEY"
docker compose down -v
```

Credentials mint into `.env` (0600, git-ignored; never committed):
`STUB_TOKEN`, `INNER_ROOT_KEY`, `EDGE_ROOT_KEY`, `INNER_BEARER`(=
`INNER_ROOT_KEY`) — the same four-hop boundary as the credentials
table above.

### Smoke receipts (2026-11-11, Docker Desktop 29.9.2, this branch)

- `PHASE0_SMOKE_OK 11 checks` — edge /health, lane-key mint via
  `/v1/admin/keys`, JSON completion through the full chain with
  `stub-ok` content + hop annotations, SSE + terminal usage frame, 401
  denial on a wrong bearer, trace id propagated end-to-end to the stub
  journal, lane `keyFp` 16-hex.
- Publish surface: only caddy publishes (8443/tcp + 8443/udp) — gates
  and stub publish nothing (`docker compose ps` empty publishers).
- TLS/h2 client leg: `proto=2 status=200` through Caddy with the
  self-signed pair.
- **h3 from the host is a Docker Desktop limitation, not a stack one**:
  Caddy serves `protocols [h1 h2 h3]` and binds UDP :8443 (wildcard,
  verified in `/proc/net/udp6`), and brew curl proves h3 against the
  real internet — but Docker Desktop's macOS UDP forwarder drops
  datagrams entirely (plain-UDP netcat probe host→published port:
  0/N delivered). On the Linux hubs (NAS/desktop native Docker) UDP
  forwarding is native; the same compose line serves h3 to the client
  leg there. TCP h2 is the verified fallback in this environment.
