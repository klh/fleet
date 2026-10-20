# Hub canary — desktop hub upstream gateway (W974, 2026-10-20)

Mission: route a measured canary Mac Buckle → Docker desktop hub Buckle →
IKEA Copilot or Z.ai, secrets in 0600 machine config, staged before cutover,
hop provenance and response proven. Scope held to hub profile/deploy + Buckle
routing config.

## Landed (repo)

- `deploy/hubctl.ts` `mint-lane-key`: the curl body rode the port slot and the
  port rode the body slot — every live mint 400'd with a "nested brace in URL"
  error while the fixture curl (which never parses URLs) passed. Fixed
  527c7e93; the test now pins the URL shape `http://127.0.0.1:<port>/v1/admin/keys`.
- `deploy/hub-compose.yaml`: the buckle-hub service stamps
  `BUCKLE_HUB_ID: ${HUB_NAME:-desktop}` — stable routing identity for relay
  baggage and per-hop audit rows. Pinned by `test/hubctl-ladder.test.ts`.
- `docs/design/buckle/hub-canary-2026-10-20.md` — this record.

## Staged (machine config, 0600, never committed)

- `~/.config/klh/stack.yaml` desktop profile: upstream groups `w974-zai`
  (→ belt :4100 → `zai-glm-5.3-flash`) and `w974-copilot-haiku` (→
  `https://api.githubcopilot.com`, `claude-haiku-4.5`, `copilot-integration-id`
  header via `adapter_config`), plus `upstream_keys.GITHUB_COPILOT_PAT`.
- `~/.claude/local-llm/buckle-spoke.env`: `DESKTOP_HUB_KEY=<w974-hop key>`,
  minted via the fixed `hubctl mint-lane-key` (24h TTL, scope
  `buckle:proxy:WRITE_`). File is 0600; the value never printed.
- `~/.claude/local-llm/upstreams.yaml`: groups `w974-canary-zai` and
  `w974-canary-copilot` → `http://127.0.0.1:4111`, `buckle: true`, so the Mac
  gate relays with W706 hop baggage. Pre-change backup:
  `upstreams.yaml.pre-w974.bak`. Loader-validated with the real `loadUpstreams`.

## Canary evidence (2026-10-20 ~08:30Z)

Instrument: an identical-config Mac gate — same env chain the launchd plist
sources (`belt.env` + `buckle-spoke.env`), same staged `upstreams.yaml`, fresh
port :14111 and fresh ledger — so the exact config the live spoke will load
was exercised without touching the lifecycle-fenced `com.suspenders.buckle-spoke`.

| Leg | Result | Proof |
| --- | --- | --- |
| canary → hub → Z.ai | 200, 2003 ms, content `canary`, usage 52 tok (20p/32c) | hub `route_audit`: `hop=forwarded`, `key=w974-hop`, `model=zai-glm-5.3-flash`, `host 127.0.0.1:4100`, `1983 ms`, trace `8868ab770cc66e3d7441e39207a523aa` |
| canary → hub → Copilot | hub refused 503 `cloud_forbidden` (owner prefs — "pins never substitute", ruling #38753 class); Mac gate surfaced 502 `no_route` | hub rows prove traversal: `hop=forwarded`, `key=w974-hop`, trace `7e32d84599a9c8684b63b3f79ca0327f`. Routing proven; egress blocked by policy, not by config. Staged rows stand for when the prefs/ruling resolve (Copilot also quota-walled to ~2026-11-01, W695.6) |

Hub auth was enforced throughout (bogus/absent bearers 401). The live spoke
ledger held zero canary rows — the spawned gate wrote nothing to the live db.

## False-positive correction

The first "successful" spoke-relayed canary (a client 200 for
`w974-canary-zai`) was the spoke's policy fallback to local
`zai-glm-5.3-flash` (:4100) — the hub had no matching audit row. Retracted and
re-proven as above. Law: verify a hop chain on the TARGET hub's
`/v1/admin/requests` (`hop=forwarded` + `key_name`) or the relaying gate's
`route_audit.target_host` — never on the client-visible status.

## Cutover (owner ops)

The buckle gate loads `loadUpstreams()` once at server start, and env vars are
sourced at every launchd start — so promotion is one restart:
`launchctl kickstart gui/$(id -u)/com.suspenders.buckle-spoke` loads the staged
ladder + `DESKTOP_HUB_KEY`. Then re-run the two canaries against :4101
(`w974-canary-zai` via `/v1/chat/completions`, `w974-canary-copilot` via
`/v1/messages`) and confirm the same hub-side forwarded rows. NEED_DECISION
#48482 documents the authority options; the full-chain proof above removes the
config risk — what remains is a restart plus a repeat measurement.

## W983 follow-up: hub-local owner prefs (2026-10-20 ~09:15Z)

The cloud_forbidden refusal was the hub's prefs defaulting closed. Land: stack.yaml
per-hub `buckle_prefs:` (allow_cloud / cost_speed) → `hubctl push` renders the
0600 `buckle-prefs.json` (buckle `loadPrefs` shape, conservative defaults when
undeclared) into the deploy dir; hub-compose binds it ro at `BUCKLE_PREFS:
/etc/klh/buckle-prefs.json`. Verified in the running container (env + ro mount
via docker inspect) and on the audit rows (`allow_cloud: 1` where the same
canary previously logged the refusal).

- Mac→hub→Copilot relay: hub rows `hop=forwarded`, `key=w974-hop`,
  `host=api.githubcopilot.com`, trace `42b96d97e4ce4b4d…` — the chain
  traverses with the prefs mount live. Z.ai relay leg re-proven 200 (prior
  owner trace `8e124bae13ed489780a5edfe725dc437`, same config).
- Hub→Copilot provider leg: direct `x-belt-hint: must cloud` request delivered
  the pinned row to api.githubcopilot.com (61s incl. the retry ladder) and got
  **429 rate_limit_error** — the W695.6 Copilot quota wall (~2026-11-01), not a
  config fault. Routing + prefs + egress all proven; provider delivery waits
  on quota.
- **Open law finding (NEED_DECISION #48672)**: a pinned ALL-cloud group can
  never deliver a hintless request — `router.walkSelected`'s W209 escalation
  gate demands `attempts >= 2` before any cloud row, unreachable when the
  group has no local rung, and `x-belt-hint` is ingress-only so a Mac relay
  cannot express `must` to the hub. Until ruled, hub-relayed Copilot pins
  surface 502 `no_route`; `must cloud` direct to the hub is the working path.
