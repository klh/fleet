# deploy/ — hub deployment (W310)

## Private native LiteLLM metrics

For a hub serving a LiteLLM transport, declare `metrics.litellm` in the
machine stack profile with `url`, `key_env` and `source_id`. The credential
name must already exist in `secrets.upstream_keys`; its on-device key file
must hold the engine's metrics authority, not a provider API key. The
existing private `upstream.env` supplies it to Buckle. No secret value is
rendered into the compose environment template or diagnostics.

The URL must be HTTPS or loopback HTTP and use `/metrics/` (LiteLLM's native
path). A Docker hostname over plain HTTP remains refused. Verify that the
declared endpoint is reachable from the hub's host-network container; do
not change URL security or start another engine to make a scrape green.
Hubs with no LiteLLM transport leave the block absent and correctly report
`not_configured`.

Authenticated `GET /v1/admin/metrics` remains the single combined read.
Its `x-buckle-litellm-metrics-source-id` header names the operator's engine
identity. Use the **same** identifier on every hub/spoke reading one engine;
those native counters and in-flight gauges must not be summed across
scrapes. A missing identifier is unknown provenance, not a unique engine.
Local file credentials keep the existing 0600/owner checks; local spokes
can declare the same identity with `BUCKLE_LITELLM_METRICS_SOURCE_ID`.

One parameterized compose (`hub-compose.yaml`) + the runtime-config shape
(`stack.example.json`). The topology law: **start topology, not hardcoded
one-offs** — a local user runs several hubs, hubs declare peers (sub-hubs),
everything is data in runtime config.

## Deploy a hub

One command, any hub (W363) — the hub's section in the machine stack.json is
the whole brief; the installer materializes it (mint → push → up, probe-gated
status):

    bash install.sh --hub <name>          # from packages/suspenders
    bun deploy/hubctl.ts deploy <name>    # the same chain, hubctl-direct
    bash install.sh --hub <name> --dry-run  # renders the hub .env only

Docker Desktop (this Mac): the desktop hub's deploy.dir is a local path and
no ssh target is declared, so mint/push/up run locally. NAS ($NAS_HOST —
same template, compose-managed via `--hub`; retires the W310 Docker Desktop
one-off and the W318-era docker-run rows):

    # the machine config (~/.config/klh/stack.json) declares the hub: ports,
    # binds, repo trees, deploy transport (ssh/dir/docker), secret PATHS.
    # hubctl materializes everything from it — nothing hand-typed:
    #   bun deploy/hubctl.ts mint <hub>     # secrets ON the hub (0600, idempotent)
    #   bun deploy/hubctl.ts push <hub>     # compose template + rendered .env
    #   bun deploy/hubctl.ts up <hub>       # docker compose up -d
    #   bun deploy/hubctl.ts status <hub>   # per-service health probes
    # one-time cutover from manual rows: hubctl push + mint, then stop/rm the
    # docker-run containers, seed the named volumes from the old host-bind
    # state (buckle.db, belt-home incl. belt.env, hub-home, the federation
    # signing key → hub-secrets), hubctl up, hubctl status.
    # Verified: boot log "root-keyed", /status 200, mint-test via
    # /v1/admin/keys (statuses only — key material never echoed).

Ports per hub live in `~/.config/klh/stack.json` (mode 600) — the
placeholders here show the shape only. `~/.claude/local-llm/hubs.json` holds
the label → candidate-URL registry `resolveHub` walks (candidates give the
fault tolerance: several URLs per hub label, first healthy wins).

## OpenRouter free routes on a hub

`openrouter-free-sync.ts sync --output <absolute-path>` reads the public
[OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/get-models)
with all output modalities and the authenticated account model list. It
atomically writes a machine-local 0600 snapshot. It admits `:free` IDs and
the exact `openrouter/free` router only when they accept and return text, have
zero prompt, completion, and request prices, and are selectable under this
account's privacy and guardrail settings. The 0600 OpenRouter inference key
is read locally for the account catalog and is never written to the snapshot
or logs. Exclusions and reasons are printed by the sync command and saved in
the snapshot. The full catalog includes paid, audio, and image models, so its
total is not a free chat route count. A failed or empty catalog fetch preserves
the previous file.

The hub's machine-level `stack.json` points
`hubs.<name>.upstreams.openrouter_free_catalog_file` at that snapshot,
sets `buckle_prefs.allow_cloud: true`, and declares its existing
`secrets.upstream_keys.LITELLM_KEY` as the **path on that hub** to the local
LiteLLM master key. The OpenRouter inference key stays in a 0600 file on the
machine running LiteLLM; it never enters Buckle. A management key is for
provisioning API keys; it is not the inference credential. The generated
route is Buckle → LiteLLM `:4100` → OpenRouter. `hubctl push <name>` merges
generated routes beneath explicit groups; `hubctl reload-upstreams <name>`
refreshes only the ladder and recreates Buckle. Both refuse a catalog
snapshot older than two hours and a missing cloud opt-in or LiteLLM key
declaration. The local LiteLLM config must contain matching `model_name`
rows and receive `OPENROUTER_API_KEY` at spawn. A restricted inference key
and a verified deployed route are required before the dashboard should
report an OpenRouter model as reachable.

### Deploy ordering: snapshot refresh vs the pinned-ref gates

After a stack `version:` bump, `hubctl deploy <hub>` is the verb that moves
the hub's deploy ref. When its push refuses a stale catalog snapshot, run
`openrouter-free-sync.ts refresh-configured` first: it writes the fresh
snapshot, but its activation tail exits non-zero mid version-bump — ssh hubs
throw "automatic LiteLLM reload currently requires a local macOS hub" and a
local hub still on the old pin fails the `reload-upstreams` ref gate. That
tail refusal is expected; the snapshot is already on disk, so proceed with
`hubctl deploy <hub>`, which re-checks the gate itself.

## Z.ai account models on a hub

The Z.ai hub inventory comes from the account's authenticated
`GET https://api.z.ai/api/paas/v4/models`. This endpoint lists model IDs
visible to the configured account; it does not prove that a completion will
succeed. Public pricing also lists image, audio, and other models that may
not appear in this account's chat catalog. They are not added as Buckle chat
routes.

Inference must target the Coding Plan wire bases — Anthropic Messages
`https://api.z.ai/api/anthropic`, OpenAI Chat Completions
`https://api.z.ai/api/coding/paas/v4`, OpenAI Responses
`https://api.z.ai/api/v1` — never the general `/api/paas/v4`. Buckle's
outbound guard (`adapter_config.blocked_outbound`) refuses the general
endpoint for guarded deployments before any network call, but a hub riding
LiteLLM hides its outbound leg behind the proxy, so the LiteLLM `api_base`
of the zai remote must itself stay on a Coding Plan base — the generated
rows carry the operator's base verbatim.

On a local Docker hub, declare these machine-level fields in its
`stack.json` profile:

```yaml
http_upstream_hosts: [host.docker.internal]
buckle_prefs: {allow_cloud: true}
secrets:
  upstream_keys:
    Z_AI_API_KEY: /private/path/zai.key
    LITELLM_KEY: /private/path/litellm.key
upstreams:
  zai_catalog_file: /private/path/zai-models.json
  zai_litellm_url: http://host.docker.internal:4100
  groups: {} # explicit aliases still take priority
```

`bun deploy/zai-catalog-sync.ts sync --hub <name>` reads the 0600 Z.ai
key file without logging it and writes the 0600 catalog snapshot atomically.
A failed fetch preserves the previous snapshot. The installed Belt
`gateway-config.ts` reads the same snapshot at
`~/.claude/local-llm/zai-models.json` (or `ZAI_CATALOG_FILE`) and adds
missing `zai-<model-id>` LiteLLM rows. Regenerate and restart LiteLLM,
verify its `/v1/models`, then `hubctl push <name>` and
`hubctl reload-upstreams <name>`. Buckle routes the catalog IDs through
LiteLLM; hubctl refuses a direct Z.ai route when catalog sync is enabled.
Snapshots older than 24 hours require a refresh before a new deploy. The
hub card reports configured models; successful routing needs a separate
inference check.

**Install preflight (W1469).** `install --wire` runs `seedLocalLlm`, whose
regen leg re-runs the home `gateway-config.ts` when `litellm.yaml` trails its
inputs. A snapshot past the 24-hour window used to fail that leg even when
the account's model set had not changed. The installer now checks the
snapshot first. A timestamp-only failure (stale, unparseable, or future-dated
`generated_at`) is verified against the live catalog through the 0600
`zai.key`, and the snapshot is rewritten in place (0600, atomic) when the
chat model set is unchanged. A real chat-model delta (added or removed IDs),
or a live catalog that cannot be read (no key, HTTP error), fails the step
loudly and names the accept path,
`bun packages/suspenders/deploy/zai-catalog-sync.ts sync --hub <hub>`.
The generator is not spawned and the last good `litellm.yaml` stays. Fresh
or absent snapshots, and a `litellm.yaml` that is already current, cost no
network call. Drift in non-chat (excluded) IDs refreshes silently.

## Hub catalog reconciliation (W1711)

`bun deploy/hub-catalog-sync.ts check --hub <name>` is the operator-invoked
dry run. Each row whose provider publishes a catalog (Copilot, Z.ai, an
OpenAI-wire `<base>/v1/models`) gets one authenticated GET with the hub's
0600 key file. The output has one verdict per row: `present`, `stale`,
`credential-rejected`, `credential-missing`, `provider-failure`,
`no-catalog`, `no-credential` or `credential-on-device` (a remote hub's key
stays on the device). It also prints `wire=supported|unsupported|unknown`
for the row's dialect. Availability is never inferred from config or a
minimal 200. Output carries verdicts and counts only: never a key, a key
path or stack contents.

`--plan-out <path>` writes the plan for review (0600). The plan can `flag`
stale rows (`catalog_stale: {source, observed_at}`) and `unflag` re-listed
rows. With `--remove-stale`, it can `remove` a stale row only while the
group keeps a row that is not stale. Nothing is substituted. Unrelated
groups, headers and betas stay byte-identical. `apply --plan <path>` applies
exactly that plan. It refuses plans older than 24 hours or made for another
stack file. Under the stack lock, it re-checks the exact stack bytes, writes
a 0600 `<stack>.pre-catalog-<sha12>.bak` and replaces the stack atomically
(0600). Exit 3 means the stack moved or the lock was held, and nothing was
written. Published Copilot endpoint, tool and stream facts go to the
canonical capability snapshot (`~/.claude/local-llm/model-capabilities.json`,
belt `ModelCapabilityRecord`), which `groupWireEndpoints` joins per group.
Coverage: `bun --cwd packages/suspenders playwright test --config
deploy/playwright.config.ts`.

## Inference-route canary (W467)

A `/status` answer proves the gate responds. The `buckle-ready` sidecar
checks that auth, routing, and an upstream accept an inference request. It
POSTs a 1-token chat completion through the hub's own front every 10 minutes
and serves the verdict on its own port (`/healthz`,
`/status` — same wire contract as the *-health sidecars):

- the model is machine-level config: `ready_model:` in the hub's stack.json
  section (`HUB_READY_MODEL`, template default `general`) — it must name a
  model the hub's routing ladder actually serves;
- the request rides the same break-glass root credential as the gate
  (`buckle.env`), resolved inside the container via `--auth-env` — an unset
  credential fails closed (config error, never "up");
- `hubctl status` reports the row and gates the exit code on it; compose
  health still hits `buckle-health` — a dead upstream degrades the verdict,
  it never restart-loops the gate.

The independent `buckle-health` sidecar checks `/status` every 5 seconds;
Docker checks that sidecar every 10 seconds. The readiness canary is marked
`x-klh-traffic: readiness` in Buckle telemetry and is not agent inference.
Both sidecars report `check` (`http-liveness` or `inference-route`) and
`intervalMs` on `/healthz` and `/status`, so dashboards can label their
different proof and sampling cadence.
It requires a completion choice, but a thinking model may spend the one token
on reasoning and return no user-visible text. Thus the `buckle-ready` verdict
is **inference-route reachability**, not a quality or answer-completeness
check. A live desktop `general` route on 2026-10-20 returned HTTP 200 with an
empty message for limits 1–32; a 64-token request returned `OK` after 48
completion tokens. Asking for an answer on every canary would be much more
expensive on that route.
Its default changes from 60 calls/hour at up to 4 output tokens each to
6 calls/hour at up to 1 output token each: 90% fewer calls and 97.5% less
maximum output-token budget (240 to 6 tokens/hour per hub). Input tokens,
provider minimum charges, and actual output may differ. A model-path failure
can take up to roughly 20 minutes to reach `down` after two failed scheduled
checks plus the confirming request; gate liveness remains on the fast path.

## mDNS advertisement (W854)

Every hub announces itself on the LAN as `_klh-hub._tcp` (instance = the
hub's label): the `mdns-announce` service runs the pure-TS announcer
(`deploy/mdns/announce.ts`) on the pinned bun image, host-networked, after
`buckle-health` proves the gate healthy. This is what hub-locate's dns-sd
discovery leg (`resolveHub` step 4) browses — until W854 the browse came
back EMPTY and `<label>.local` resolved only via per-machine loopback
mappings. Knobs live in the hub's stack.json `mdns:` block (`port`, `addr`,
`hostname`, `interval_ms`, `health_port`, `sidecar_port`; undeclared =
template defaults; the advertised port defaults to `buckle_port`). The
announcer serves its real state on `:4114/healthz`; the OUTSIDE-PROCESS
`mdns-health` sidecar polls that and serves the verdict on `:4115` —
compose health hits the sidecar, never the announcer (owner law). An
undetectable/undeclared `addr` SKIPS the A record — the hub is never
advertised as 127.0.0.1. `hubctl status` probes the mdns-health verdict.

## Source pinning (mono deploy, W422.7)

Hubs build from ONE pinned Fleet monorepo checkout, not per-package repos:
the compose `fleet-repo` sidecar clones `$HUB_FLEET_REPO_URL` at
`$HUB_FLEET_REF` and every service runs from its `packages/<name>` subtree
(`fleet-deps` installs the workspace once, frozen-lockfile). hubctl renders
both from the stack's `version:` — a hub deploy without a pinned version
(a branch name, `main`) is refused, per-package refs/origins are rejected,
and the archived `klh/{buckle,suspenders,belt}` origins cannot deploy the
monorepo. One version string pins the whole hub (stack.json law).

Cutting that version is a verb (W1303.6), not a hand edit — from
`packages/suspenders`:

    bun scripts/release.ts status                        # agreement + tag + machine pin
    bun scripts/release.ts cut --bump patch --items W1234 [--yes] [--push]

`cut` bumps EVERY package manifest and internal `@klh/*` dep spec in one
commit, tags `vMAJOR.MINOR.PATCH` (annotated), and prepends the CHANGELOG
release line with the merged item ids; without `--yes` it prints the plan
only. The machine `version:` pin stays operator-owned (0600): set it to the
new tag after cutting — `status` and the install tail render the drift
until it matches.

## Runtime + embedded SQLite verification (W443)

Fleet's ledgers run WAL, so the artifact's embedded SQLite must carry the
[WAL-reset fix](https://sqlite.org/wal.html#walresetbug) — the race is
present 3.7.0 → 3.51.2, fixed in 3.51.3 (2026-03-13), backported to
3.44.6/3.50.7. The verdict reads the ARTIFACT, never the host `sqlite3`:

- **Hub + sim containers** run `oven/bun:1`, whose bun vendors its own
  SQLite amalgamation on Linux. `deploy/runtime-info.ts` reports and gates
  it; the CI `runtime-sqlite` job runs `--check` inside the same floating
  tag every push, and `hubctl status`/`deploy` exec it in the running
  buckle-hub (informational — health gates the exit code).
- **Verified (2026-10-07):** `oven/bun:1`, `1.4` and `1.4.2` resolve to one
  digest family, bun v1.4.2 vendors SQLite **3.53.2** (source id
  `2026-06-03 …f1a24`, `src/jsc/bindings/sqlite/sqlite3.c`) ≥ 3.51.3. bun
  main vendors 3.53.4.
- **Residual exposure:** bun on **macOS links the system SQLite** (Apple
  build — source id carries the `aapl` suffix); this Mac's bun 1.4.2 reports
  3.51.0, whose base is in the affected range and whose Apple patch state
  cannot be verified from outside. Mac-side runtimes (spoke, governor) stay
  exposed until the advisory's fix ships in an Apple system update — the
  probe prints `UNVERIFIED` there by design.

A version below 3.51.3 passes `--check` only with documented vendor-backport
evidence (`SQLITE_PATCH_EVIDENCE` env).

## Enterprise layer

The private `*-remote` overlays (buckle-remote, belt-remote,
suspenders-remote) are config-over-code: the public bases run, the overlay
profiles set auth.required, tokens.ttlHours, oidc.enforced (W191 lives in
the base), admin.gui. Entra ID tenant/app values live only in stack.json.
W372: the deploy path consumes the whole auth block — hubctl render
materializes auth.oidc/auth.tokens into the .env (fail-closed on a partial
oidc block) and the buckle gate builds its JWT validator from the
materialized env (`BUCKLE_OIDC_*`), so Entra is config-only end to end.

A hub rides the private tier purely by config (W493): the profile's
`repos` entries carry the overlay monorepo's origin and — because an
overlay resolves its pinned public base under `node_modules/<dep>/packages`
— `repos.src` points at that packages root (`HUB_FLEET_SRC` in the rendered
.env; unset keeps the public monorepo layout). The private git-pull needs a
deploy key minted ON the hub device (0600, never printed); nothing in the
public repo changes to flip.

## Peer edges

Hubs declare peers in runtime config: `hubs.<label>.peers` lists hub LABELS
this hub reaches directly — the start-topology graph is data, never
hardcoded (hubctl reads it; `deploy/stack.example.json` shows the shape).
First edge (W322): the nas hub declares `desktop`. The belt-remote hub
profile mirrors its hub's edges as `federation.peers` — labels only, the
host/port/key values stay behind the labels in stack.json.

Propagation (W362): a hub pulls each declared peer's
`/federation/policy-manifest` on an interval (`hooks/bin/federation-peers.ts`;
the compose `peer-pull` sidecar runs it on hubs, labels via the
hubctl-rendered `HUB_PEERS`). The content-addressed manifest version is the
change detector — a version flip on the next cycle means the peer's policy
changed; per-peer last-known state lives under the federation home
(`federation-peer-<label>.json`). A peer that is down degrades one cycle
(last-known kept), never blocks the hub. Peer auth = a spoke-scoped key
minted on the PEER hub (`buckle:spoke:READ_`), resolved per label by the
same chain as the URL (env override / hubs.json registry).

## Browsing a remote hub board

Boards enforce the W264 host guard: only `*.local` names + loopback pass.
A remote hub board is fronted by the Mac's Caddy under a `<label>.local`
name (klh-local register <label> --upstream host:port — b6528ba) with the
board's SUSPENDERS_ALLOWED_HOSTS set to that name. Example:
https://nas-hub.local → $NAS_HOST:7799.

## Release manifest + SBOM (W698)

`bun deploy/hubctl.ts manifest <hub> [--out <dir>]` (or
`bun deploy/release-manifest.ts --pinned <ref> --out <dir>`) emits:

- `release-manifest.json` — fleet sha (+ the stack version the hub pins and
  whether it equals the checkout), `bun.lock` sha256, every compose image
  digest (`unpinnedImages` must be empty), the schema versions a fresh
  governor.db / knowledge.db reach through the real migration ladder, and
  sha256 checksums of compose, lock, SBOM and notice.
- `sbom.cdx.json` — CycloneDX 1.5 from `bun.lock` (purl + sha512 per package)
  plus the digest-pinned container images.
- `THIRD-PARTY-NOTICES.txt` — license per installed package.

Deterministic (no clock): same checkout → same bytes. CI job
`release-manifest` uploads all three and fails on a floating image. The
schema upgrade / migration-failure / rollback-compat contract is
`test/release-manifest.test.ts`.

## Trace receipts over a managed ssh tunnel (W1097)

A hub's trace-receipt plane (the buckle gate's
`/v1/admin/traces?trace_id=<32-hex>`) is plain HTTP on the LAN, and the
hub's TLS front carries an untrusted certificate — so the bounded trace
connector (packages/telemetry/src/remote-traces.ts) never points at the hub
directly: direct HTTP would carry the read key in the clear and HTTPS would
need trust weakened. `hubs.<label>.trace_tunnel` declares the trusted
transport instead: a managed ssh tunnel. The read key rides the ssh
channel; the connector fetches `http://127.0.0.1:<listen_port>/` on this
device — the one non-https form its URL law admits.

    # ~/.config/klh/stack.json (mode 600, placeholders here)
    hubs:
      nas:
        trace_tunnel:
          listen_port: 14101   # on THIS device, 1024–65535
          # target_port: 4101  # default = buckle_port
          read_key: /path/on/this/device/nas-trace-read.key  # 0600

    bun deploy/hubctl.ts trace-tunnel nas up      # ssh -N -L, 0600 state, wait for forward
    bun deploy/hubctl.ts trace-tunnel nas status  # banked verdict (exit 1 = down)
    bun deploy/hubctl.ts trace-tunnel nas down    # SIGTERM + reap state (idempotent)
    bun deploy/hubctl.ts trace-tunnel nas peer --file ~/.config/klh/trace-peers.json

`peer` renders the connector peer row into the private 0600 peers file —
the merged bytes are validated with the connector's OWN law (parsePeers)
before they land, so hubctl never writes a file the reader would reject.
Every readRemoteTraces answer carries a coverage block
({hubs, ok, degraded, by_hub}) — per-read proof of what was attempted and
what answered, counts + status strings only. Plan law: undeclared =
not configured (null, never an error); a declaration without `deploy.ssh`
refuses — the tunnel IS the trusted transport. Tests:
deploy/trace-tunnel.test.ts (plan law, argv shape, peers merge, lifecycle
with an injected child, e2e through a real loopback server) and
telemetry/test/remote-traces.test.ts (connector law + coverage).
