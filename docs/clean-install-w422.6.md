# W422.6 — the poison: clean install from the monorepo

2026-10-07, lane `autow422-6-p98b319584008df14`. The install was proven in
two stages: an isolated clean-machine install (no live-state help), then the
live cutover on this machine. Everything below was verified with real
output, not assumed from exit codes.

## Stage A — isolated clean install

Temp HOME + temp prefix + temp shim bin (mkdtemp), warm bun cache pointed at
the real one (offline resolution needs it — a truly cold machine needs
network or `--prefer-offline`):

```
HOME=$tmp SUSPENDERS_PREFIX=$tmp/.claude/hooks/suspenders \
SUSPENDERS_SHIM_BIN=$tmp/.local/bin \
bash packages/suspenders/install.sh --wire --skip-models
```

Exit 0. Poison checks against the INSTALLED tree (the monorepo-review P1
failure — installed board modules importing `../../../blam/...`):

- `bun -e 'await import(...)'` on installed `board/prompt-transform.ts` and
  `board/orch.ts` — both import OK. The P1 poison is fixed (sync-harness
  links `node_modules/blam` + `<prefix>/blam` into the staged payload).
- installed `bin/work.ts ready` and `bin/coord.ts fleet` run against the
  real graph.
- settings.json wired with the temp prefix paths; shims published;
  local-llm home seeded (19 kit files, tier.json emitted from the fresh
  copy — proving the tier emission path works when the runtime copy isn't
  stale).

## Stage B — live cutover

`bash packages/suspenders/install.sh --wire --with-launchd` from the fleet
worktree. syncHarness/ensureShims/seedLocalLlm/downloadModels/releaseNotify
all ✓; registerCaddy failed (see below) — everything else landed. The
prefix flipped to a new generation of this branch (receipt-verified).

Verified after the cutover, in order:

| Surface | Check | Result |
| --- | --- | --- |
| swarm serve | `bun ~/.claude/local-llm/swarm.ts status` | minimal residents :8902/:8913 + router :4000 up — exactly the minimal-tier manifest |
| buckle spoke | `GET :4101/health` | ok |
| fleet board | `GET :7799/api/tasks` | live JSON (628 KB) |
| fleet-loop | launchd PID + plist | runs from the prefix symlink; picks up new generation on next spawn |
| session-start | hook cmd + smoke run | wired to `bun $PREFIX/session-start.ts`; imports resolve; kill-switch path exits 0 |
| hubctl up desktop | hubctl status + raw curls | all hubs 200 (below) |

### Desktop hub — what was actually broken

Three independent faults, all fixed or quarantined:

1. **No `version:` pin in stack.yaml.** `hubctl deploy` refuses to run
   unpinned; `up` does not — it happily re-ran a stale pre-pin `.env` (no
   `HUB_FLEET_REF`) and every container crash-looped on pre-monorepo paths
   (`Module not found src/server.ts`). Follow-up: W422.6.2.
2. **Port collisions on loopback.** desktop `belt_port: 7792` collided with
   klh-local's bar (`bar.local`, W148 convention, installed 2026-10-07
   16:22). Moved to 7793. Desktop `store_health_port` default 7794
   collided with the legacy host `com.suspenders.store-server` LaunchAgent.
   Moved to 7798. Both are machine-config edits (backup:
   `~/.config/klh/stack.yaml.before-w4226-pin`).
3. **Caddy registration "failure" was a reload artifact.** `klh-local
   register` hot-reloads; with the `http://:80` catch-all the reload's
   v4-specific rebind fails (`permission denied`) even though fresh starts
   work and fragments land correctly in `sites/`. `launchctl kickstart -k
   gui/501/com.klh-local.caddy` completed the registration: suspenders.local,
   bar.local, belt.local all 200. Lesson: `lesson.klh-local-caddy-reload`.

Final desktop state (probes against the REAL targets, owner law):

```
buckle :4111/status → 200      buckle-health :4112/healthz → 200
board  :7809/status → 200      board-health  :7800/healthz → 200
store  :7796/status → 200      store-health  :7798/healthz → 200
belt   :7793/api/status → 200  belt-health   :7790/healthz → 200
```

### Open (NEED_DECISION #25273)

`desktop-peer-pull` is stopped, not green: the pushed compose template (this
branch, carrying the W362 peer-pull service) references
`hooks/bin/federation-peers.ts`, but the pinned stack version
(`5234813`, codex/nas-demo-reviewed-20261007) does not ship that file —
template/pin skew. Resolves when a W362-carrying branch lands on main and
the pin advances. Follow-up W422.6.1 covers the related installer gap
(stale belt-owned runtime copies; the `registry-emit.ts tier` verb hits a
pre-W507 runtime copy on this machine, so `tier.json` is never emitted and
the swarm runs on the ≤4 GB failsafe set — same minimal residents today).
