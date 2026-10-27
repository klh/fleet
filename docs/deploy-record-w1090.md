# Deploy record W1090 — Fleet release pinned and verified across all four hubs (2026-10-23)

One reviewed Fleet base ref, one matching private overlay, machine stack pins coherent,
every configured hub deployed through hubctl and health-verified from outside its process.

## Release chain (published refs)

- **Public base ref**: tag `fleet-2026-10-23-74605857` on `klh/fleet` (origin), points at
  `74605857` (= origin/main HEAD at pin time, 2026-10-23 12:05 CET).
- **Private overlay**: `klh/fleet-enterprise` `origin/main` = `bdc6806559e282c806fa5f64c5e071e37b7e1208`
  ("Pin enterprise stack to fleet-2026-10-23-74605857"), pinning the public base through
  git-dep specs `github:klh/fleet#fleet-2026-10-23-74605857` in the root + the three
  `-remote` package.json files + `bun.lock`.
- **Machine stack pins**: `~/.config/klh/stack.yaml` `version: fleet-2026-10-23-74605857`,
  every hub profile `repos.ref: bdc68065…` (GH002: the 40-hex overlay pin commit is the
  deployable ref in the private origin; the public tag rides the overlay's git-dep pins).

## Pin coherence (render == deployed bytes)

Current stack.yaml re-renders exactly the deployed hub .envs:

| hub | rendered | staged/remote | ref match | delta |
| --- | --- | --- | --- | --- |
| desktop | 19 lines | 19 lines (local staging) | yes | `HUB_FLEET_REPO_URL` line only (render prints the redacted comment; staged carries the credential-bearing value) |
| ikea | 30 lines | 30 lines (local staging) | yes | same |
| zai | 26 lines | 26 lines (local staging) | yes | same |
| nas | 23 lines | 23 lines (remote `~+/volume1/docker/hub/.env`) | yes | none |

`hubctl up` pin gate (W422.6.2) compares `HUB_FLEET_REF` against the stack `version:` tag —
an overlay hub pins the overlay pin-commit sha, so the gate refuses every overlay hub;
the W422.6.2 gate predates overlay refs. Owner-side fix candidate: resolve `version` →
`repos.ref` for overlay hubs before refusing.

## Deploy leg + outside-process health (all green)

`hubctl status` (sidecar probes; degrade on consecutive misses, re-probe before down):

- **desktop**: buckle :4111 + ready :4113, board :7800, store :7794, belt :7790,
  model-store :7801, mdns :4115 — **all healthy**; runtime bun 1.4.2 · SQLite 3.53.2
  (WAL-reset fix verified).
- **nas**: full container set running/healthy (buckle/board/store/belt/belt-model :8915,
  model-store, mdns, peer-pull) — **all healthy** (checked ~23:50 CET; the host stopped
  answering ssh ~15 min later — see identity note).
- **ikea**: buckle :4203/ready, board :7821, store :7823, belt :7825, model-store :7827,
  mdns :4205 — **all healthy**.
- **zai**: buckle :4302 + ready :4303, board :7841, store :7843, belt :7845,
  model-store :7847, mdns :4305 — **all healthy**.

## Runtime identities (what the containers actually pulled)

`fleet-deps` init container runs `git fetch --depth 1 origin $HUB_FLEET_REF && git reset
--hard FETCH_HEAD` (hub-compose.yaml:124), then installs the overlay; bun resolves the
public base through the overlay's git-dep pin:

- desktop `desktop-fleet-deps`: `+ fleet@github:klh/fleet#7460585…` — the pinned tag.
- zai `zai-fleet-deps`: `+ fleet@github:klh/fleet#7460585…`
- ikea `ikea-fleet-deps`: `+ fleet@github:klh/fleet#7460585…`
- nas: .env pin + health verified before the host stopped answering ssh; the
  deps-log identity probe is blocked by unreachability (2 ConnectTimeout attempts).
  Re-probe when the host returns: `hubctl exec nas docker logs nas-fleet-deps`.

Desktop containers image: `oven/bun:1@sha256:9114c058…` (digest-pinned pull).

## Desktop readiness diagnosis

Green on the pinned release: buckle-ready :4113 → 200 (the front readiness probe),
buckle :4111 healthy, board/store/belt/model-store sidecars healthy. No action needed;
the W1090-era suspect (readiness flapping) did not reproduce — the attributable
probe-verdict work (W1124.43) rides the next pin, not this release.

## Refill cron

Not armed. No launchd label, no fleet-loop refill task, no cron entry created.

## Next-cycle candidate (owner decision)

Tag `fleet-2026-10-23-82b9d3d9` (W993.4 + W1124.43 era) was pushed to origin this session
as the next pin-cycle candidate. Re-pinning is owner-side: the W70 gate reserves `main`
moves (fleet AND fleet-enterprise) for the merge ladder/owner, so the overlay pin commit
on `fleet-enterprise` main, the stack flip (`version:` + `repos.ref`) and the four-hub
redeploy await the owner's GO.

## How to verify

    bun packages/suspenders/deploy/hubctl.ts status desktop   # and nas | ikea | zai
    bun packages/suspenders/deploy/hubctl.ts exec desktop docker logs desktop-fleet-deps
    git -C /Volumes/Sensitive/github/klh/fleet ls-remote --tags origin fleet-2026-10-23-74605857
    git -C /Volumes/Sensitive/github/klh/fleet-enterprise ls-remote origin main   # bdc68065…
