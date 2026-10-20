# deploy/ — hub deployment (W310)

One parameterized compose (`hub-compose.yaml`) + the runtime-config shape
(`stack.example.yaml`). The topology law: **start topology, not hardcoded
one-offs** — a local user runs several hubs, hubs declare peers (sub-hubs),
everything is data in runtime config.

## Deploy a hub

One command, any hub (W363) — the hub's section in the machine stack.yaml is
the whole brief; the installer materializes it (mint → push → up, probe-gated
status):

    bash install.sh --hub <name>          # from packages/suspenders
    bun deploy/hubctl.ts deploy <name>    # the same chain, hubctl-direct
    bash install.sh --hub <name> --dry-run  # renders the hub .env only

Docker Desktop (this Mac): the desktop hub's deploy.dir is a local path and
no ssh target is declared, so mint/push/up run locally. NAS ($NAS_HOST —
same template, compose-managed via `--hub`; retires the W310 Docker Desktop
one-off and the W318-era docker-run rows):

    # the machine config (~/.config/klh/stack.yaml) declares the hub: ports,
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

Ports per hub live in `~/.config/klh/stack.yaml` (mode 600) — the
placeholders here show the shape only. `~/.claude/local-llm/hubs.json` holds
the label → candidate-URL registry `resolveHub` walks (candidates give the
fault tolerance: several URLs per hub label, first healthy wins).

## OpenRouter free routes on a hub

`openrouter-free-sync.ts sync --output <absolute-path>` reads the public
[OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/get-models)
and atomically writes a machine-local 0600 snapshot. It admits only `:free`
model IDs that accept and return text and have zero prompt, completion, and
request prices. The snapshot contains model IDs and Buckle route definitions,
never a key. Free IDs excluded because they lack a supported text chat path or
have a fee are recorded with a reason in the snapshot and printed by the sync
command. A failed or empty catalog fetch preserves the previous file.

The hub's machine-level `stack.yaml` points
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

## Z.ai account models on a hub

The Z.ai hub inventory comes from the account's authenticated
`GET https://api.z.ai/api/paas/v4/models`. This endpoint lists model IDs
visible to the configured account; it does not prove that a completion will
succeed. Public pricing also lists image, audio, and other models that may
not appear in this account's chat catalog. They are not added as Buckle chat
routes.

On a local Docker hub, declare these machine-level fields in its
`stack.yaml` profile:

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

## Inference-route canary (W467)

A `/status` answer proves the gate responds. The `buckle-ready` sidecar
checks that auth, routing, and an upstream accept an inference request. It
POSTs a 1-token chat completion through the hub's own front every 10 minutes
and serves the verdict on its own port (`/healthz`,
`/status` — same wire contract as the *-health sidecars):

- the model is machine-level config: `ready_model:` in the hub's stack.yaml
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
mappings. Knobs live in the hub's stack.yaml `mdns:` block (`port`, `addr`,
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
monorepo. One version string pins the whole hub (stack.yaml law).

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
the base), admin.gui. Entra ID tenant/app values live only in stack.yaml.
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
hardcoded (hubctl reads it; `deploy/stack.example.yaml` shows the shape).
First edge (W322): the nas hub declares `desktop`. The belt-remote hub
profile mirrors its hub's edges as `federation.peers` — labels only, the
host/port/key values stay behind the labels in stack.yaml.

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
