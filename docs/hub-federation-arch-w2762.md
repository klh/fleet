# Hub federation architecture — W2762 (2026-11-05)

Owner directive 2026-11-05. This doc maps the owner's target hub-federation
model onto what fleet code actually does today, names the gaps as rows, and
records the dark-label root cause that triggered the investigation.

Target model (owner's words, condensed):

1. hubs **expose models** (`/v1/models`);
2. locals connect **to** hubs;
3. hub-to-hub connections allowed;
4. worklanes flow through everything (lane rides its hub, hub may delegate);
5. each hub can **limit models and tiers by rights** (per-key/per-lane
   entitlements);
6. hub-to-hub exposure is also rights-limited;
7. any hub is arch-wise nearly a local dev machine and can expose its models
   to others;
8. a hub may also run **belt for small local models** (kev as the
   auto-router, openrouter-style: one model id that routes by
   class/complexity).

## The dark labels — root cause (deliverable 1)

SYMPTOM: `~/.claude/local-llm/hubs.json` labels `ikea → http://127.0.0.1:4201`
and `zai → http://127.0.0.1:4301` dark (connection refused) from macOS.

SOURCE of the labels+ports: they are real, correctly-rendered hub fronts.
`~/.config/klh/settings.json` `hubs.{ikea,zai}` declare `ports.buckle`
4201/4301 (+ board 7820/7840, store 7822/7842, belt 7824/7844, model_store
7826/7846, buckle_ready 4203/4303); hubctl render materialized them into
`~/.config/klh/hub-{ikea,zai}/.env` (`HUB_BUCKLE_PORT=4201/4301`) and the
compose stacks came up — the containers ran, bound their ports, and the
in-container logs prove it (`shadow router on http://127.0.0.1:4301`).

WHY DARK: **Docker Desktop (macOS, server 29.9.2) host-network socket
forwarding does not re-adopt listeners that were bound before a backend
restart.** The hub containers (all `network_mode: host`) started 08:18Z; the
Docker Desktop backend restarted 09:18Z (brew upgrade window — bun 1.4.2 →
1.4.4_1 landed the same morning). After the backend restart the VM-side
listeners still existed (`/proc/net/tcp` inside the VM: LISTEN 127.0.0.1
:4201/:4301/:4111) and intra-VM loopback answered (the health sidecars,
host-network too, kept probing green) — but the macOS-side forwarder never
re-registered those pre-existing sockets, so every macOS probe got
ECONNREFUSED. Verified empirically:

- same netns A/B: a fresh `Bun.serve` bound inside the live zai container
  (`docker exec … port 4390`) was instantly reachable from macOS; the
  adjacent 4301 listener was not;
- `docker restart` of the buckle container (socket re-bound after the
  backend restart) → 4301 reachable immediately.

Sibling evidence: `desktop` :4111 (same compose shape) was equally dark; the
`nas` hub :4101 (real Linux host, no Docker Desktop forwarding layer) was up
throughout. This is the same family as `lesson.hub-reboot-needs-compose-up`
(restart-policy restores containers, publishing dead) — the 2026-11-05 shape
adds: **host-network listeners bound before a Docker Desktop backend restart
are skipped by the re-adoption pass, while containers keep looking healthy.**

FIX (deliverable 2, applied and verified): `docker restart` of the hub
containers so the sockets re-bind under the live backend. Restarted: all
three buckle fronts, then every host-network hub container (board/store/
model-store/ready/health/mdns/peer-pull for zai, ikea, desktop). Post-fix
probe sweep (macOS): 4201/4301/4111 `/status` 200; 7820/7840/7809 board,
7822/7842/7796 store, 4202/4302/4112 buckle-health, 4203/4303 ready — all
HTTP 200. `/v1/models` with each hub token: ikea 200 (20 models), zai 200
(13), desktop 200 (22). A live ride through zai (`glm-5.3-flash`, temp
proxy key, since revoked) returned 200 with real content + usage.

WHY THE AUTO-HEAL MISSED IT (the second half of the root cause): W2309
`hub-port-heal` (fleet-loop maintenance, 15-min cadence) exists precisely
for this signature and its dry-run today is green — but the running
fleet-loop `watch` (pid 76666, started 09:22) has been a zombie since birth:
it spawns each `once` cycle child via `process.execPath`
(`/opt/homebrew/Cellar/bun/1.4.2/bin/bun`), and the brew upgrade removed
that directory — every cycle spawn dies ENOENT
(`/private/tmp/fleet-loop.log`). Last recorded heal run: 2026-11-05T00:57Z,
hours before the outage window. So: two stacked failures — Docker Desktop
lost the forwards, and the self-heal loop that would have restored them was
dead from a bun version drift. (Zombie watch process was left running for
the owner/fleet-loop lane to recycle deliberately — it holds no listeners.)

Not-dark note: `nas` label resolves and `/status` is 200; its
`/v1/models` returns 403 for both the hubs.json token and the
`nas-cache-read.key` — the minted key carries cache-read scope, not proxy
scope. Pre-existing condition, unrelated to the outage; gap row G7.

## Current architecture vs the target model (deliverable 3)

What fleet code does today, leg by leg:

### L1 — hubs expose models `/v1/models` — PRESENT

`packages/buckle/src/models-route.ts` serves `/v1/models` from the upstream
pool (`inherit_defaults: false` on hub-rendered `upstreams.hub.json` means a
hub exposes exactly its own ladder, never fake local `:890x` rows —
`packages/buckle/src/upstreams.ts` W1123). The route is principal-aware:
`principalOf(req)` filters listed groups to the key's class entitlements
(W2635.1 — see L5). Verified live on all three Mac hubs (200 + model lists
above); nas serves 403-for-this-key (auth working, token scope too narrow).

### L2 — locals connect to hubs — PRESENT (label plane) / THIN (upstream plane)

Label plane: `resolveHub` (`packages/suspenders/hooks/lib/hub/hub-locate.ts`)
walks env override → one-off candidates → settings.json/stack.json profile
URL → `hubs.json` candidates, with alive-probes and quiet-hours dark windows;
`~/.claude/local-llm/hubs.json` rows (desktop/nas/ikea/zai) each carry a
front token. Lanes: `.prefer hub=<label>` pins a lane to a hub; dispatch
mints the lane key AT the hub and rides `<hub-url>/w/<sid>`
(`packages/suspenders/scripts/lib/hub-lane.ts` W615) so hub-routed usage
lands in the hub's own audit trail.

Upstream plane (a local's own router treating a hub as an upstream): the
committed base `upstreams.json` has no `buckle: true` rows; machine
`~/.claude/local-llm/upstreams.json` has many `http://127.0.0.1:4301` /
`:4111` rows but ALL plain (no `buckle: true`) — they work as openai-dialect
upstreams but do not carry W706 relay hop-baggage (origin + peer markers).
Functional, minus federation accounting.

### L3 — hub-to-hub — PLUMBING PRESENT, UNUSED

Code supports it fully: an upstream row with `buckle: true`
(`packages/buckle/src/upstreams.ts` W706) makes the relay leg carry hub hop
markers; `peers: [<labels>]` on a hub profile renders `HUB_PEERS` into
compose and `federation-peers.ts` (W362) pulls peer policy manifests on a
loop (every hub stack ships a `<name>-peer-pull` container). Machine conf:
`nas.peers: [desktop]`, `ikea.peers: [desktop]`, `desktop/zai` none — but
NO hub's `upstreams.hub.json` contains a `buckle: true` row pointing at
another hub, so no ride actually cascades hub→hub today. Policy propagation
(peers) is wired; ride delegation is not exercised.

### L4 — worklanes flow through everything — PRESENT

Verified end-to-end: lane key minted at hub → anthropic/openai faces →
router → upstream ladder (zai ride 200 with usage). Delegation (a hub
forwarding to another hub) rides on L3 and is therefore unexercised (same
gap). `/w/<sid>` faces exist on every hub front.

### L5 — per-key/per-lane rights and tier limits — PRESENT (two mechanisms)

- Scopes: `packages/buckle/src/gov/scopes.ts` — `buckle:<resource>:<READ_|
  WRITE_|QUERY_>`, per-lane keys minted `buckle:proxy:WRITE_`; the hub store
  (`buckle:store:READ_` dev-pull keys) and knowledge faces have their own
  pairs. This is per-KEY rights, enforced at the governance gate.
- Account policy (W1265.1): `packages/buckle/src/account-policy.ts` maps
  credential mint-name (+ optional verified `x-klh-repo` claim) →
  account-class → entitled tier/group set; out-of-class group = 403
  `buckle.tier_entitlement` BEFORE routing with zero outbound; ladder
  fallback never crosses the class boundary. `HUB_REPO_TIER_POLICY` stages
  the operator's 0600 `repo-tier-policy.yaml` per hub (ikea carries one;
  zai's is empty). `/v1/models` filters to the same entitled set (W2635.1).
- Entitlement menu: `/federation/entitlements` (gov/federation.ts W233.1)
  answers the class's model menu — 501 in solo posture, populated via the
  enterprise overlay's provider seam.

### L6 — hub-to-hub exposure rights-limited — PARTIAL

The building blocks exist (scopes on the connecting hub's key; account
policy classes keyed by mint-name prefix — `fleet-ikea-*` vs
`fleet-personal-*` — would govern a peer hub's pulls the same as any
client; `visibility: spoke-private` excludes groups from the entitlement
menu). But because no hub-to-hub ride rows exist (L3), no hub today has a
distinctly-scoped PEER credential class, and account-class binding is
documented for repo/lane identities, not hub identities. Gap row G3.

### L7 — a hub is nearly a local dev machine — MOSTLY TRUE BY CONSTRUCTION

Every hub is the same fleet monorepo git-pinned (`HUB_FLEET_REF`), running
the same buckle/belt/board/store/model-store images with compose profiles
(`packages/suspenders/deploy/hub-compose.yaml`); a hub differs from the Mac
dev machine only in conf (stack.json profile) and posture (auth on, root
keyed). Divergence rows: hub buckle binds loopback by default
(`BUCKLE_BIND=127.0.0.1`) — reach-in from other machines requires an
explicit bind + auth (bind_refused guard enforces); the Mac dev machine's
swarm (`:890x` specialists) is NOT part of the hub compose set (only
`belt-model` profile can front one external server).

### L8 — belt on a hub for small local models / kev auto-router — SCAFFOLD PRESENT

- `belt_model` compose profile (W2329): `belt/bin/model-proxy.ts` fronts an
  external OpenAI-wire model server (`HUB_BELT_MODEL_UPSTREAM`), inventory =
  its live `/v1/models`; no hub profile declares it yet (no
  `belt_model` block in machine settings.json).
- kev auto-routing: `belt/bin/router-shim.ts` (the `:4000` complexity-v3
  router) does openrouter-style class routing with a kev escalation tier
  (`kevEligible`/`kevEscalateVeto`); hub-side, `kev-model-pick.ts` (W2677)
  makes dispatch pick a model from a hub's LIVE `/v1/models` for bare
  `hub=` lanes (kev-chooses; `default_models` is the fallback safety net).
  What does NOT exist: kev/router-shim running INSIDE a hub stack as a
  served model (a hub-exposed `general`-style id that routes by complexity
  across the hub's own ladder). zai's `general` group (litellm leg) is the
  nearest ancestor. Gap row G5.

## Gap rows (named, dispositioned)

| id | gap | evidence | disposition |
|----|-----|----------|-------------|
| G1 | Docker Desktop backend restart orphans pre-bound host-network listeners; containers stay "healthy" while macOS faces stay dark | 2026-11-05 outage; in-VM LISTEN rows + ECONNREFUSED from macOS; exec-bind A/B test | FIX LANDED (restarts) + `lesson.hub-reboot-needs-compose-up` updated shape; residual: heal loop must catch this signature — see G2 |
| G2 | fleet-loop `watch` spawns cycle children via `process.execPath`; a brew bun upgrade mid-life kills every spawn (ENOENT) and the loop zombies silently | `/private/tmp/fleet-loop.log` ENOENT bun/1.4.2; heal last ran 00:57Z, outage 09:18→14:5x | NOT FIXED HERE (owned by fleet-loop surface) — needs `bun` from PATH resolution or a liveness alert on cycle-spawn death; watcher process still zombie, needs recycle |
| G3 | hub-to-hub rides: `buckle: true` + peers plumbing exists but zero hub upstreams declare another hub; no peer credential class in account policy | `upstreams.hub.json` scans (no `buckle:` rows); `peers:` declared but pull-only | open — first hub→hub ladder row + a `fleet-peer-*` account class |
| G4 | local→hub upstream rows are plain (no `buckle: true`) so hub-relay accounting (W706 hop markers) is bypassed for local rides | machine `upstreams.json` rows at `:4301`/`:4111` | open — cosmetic until cross-machine audit rollup matters |
| G5 | no in-hub auto-router service (kev/router-shim as a hub-served model); `belt_model` profile unused | no `belt_model` block in settings.json; hub `/v1/models` has no complexity-routed id | open — owner's openrouter-style target for hubs |
| G6 | `hub-port-heal` probes `127.0.0.1:<port>/healthz` only on buckle/board/store/belt health faces; a dark BUCKLE face with live sidecar (sidecar is host-net and probed… from macOS in this outage it was also dark) — signature held here, but heal never ran (G2); after G2 fix, re-verify the heal covers the pre-restart-listener shape (healthyWithoutPorts matches host-net containers trivially since Ports={} always) | `hub-port-heal.ts` signatureMatch | verify-after-G2; consider a macOS-side face probe as the trigger of record |
| G7 | nas hub front token (hubs.json + `nas-cache-read.key`) is cache-read scope; `/v1/models` 403 for it — label works, catalog rides broken for that key | 403 both tokens, bogus key 401 (auth distinguishes) | open — remint a proxy-scope nas front key or scope the catalog face READ_ |
| G8 | `desktop.buckle_port` 4111 dark in the same window but never noticed — no per-hub label liveness surface in `work lanes`/board | outage evidence | open — surface `resolveHub` label liveness on the board |

## Verification record (this investigation)

- macOS port probes pre-fix: 4201/4301/4111 ECONNREFUSED; 4101 (nas) 200.
- In-container probes during outage: zai `/health` and `/v1/models` 200.
- Same-netns A/B: exec-bound :4390 reachable, :4301 refused — listener-age,
  not topology.
- Post-restart sweep: all 14 hub faces 200 (buckle/board/store/health/ready
  × ikea/zai/desktop).
- `/v1/models` with hub tokens: ikea 20, zai 13, desktop 22 models; nas 403
  (scope, G7).
- Ride-through: zai `glm-5.3-flash` chat completion 200, content +
  reasoning-token usage; probe key minted then revoked (200).
- Heal dry-run post-fix: desktop/nas/ikea/zai all `ok`, 0 dead faces.
