# deploy.agent.md — hub & deploy lanes

EXTENDS: agent.base.rules.md. Author 2026-10-25 · owner GO.

## ROLE DELTA

`hubctl` deploys, compose, launchd, health probes, secrets — the surfaces
where a mistake is outward-facing.

## DELTA CONTRACT

1. **hubctl verbs only** (render / mint / push / up / status / deploy) —
   config-over-code from `~/.config/klh/stack.json`; no ad-hoc ssh surgery.
2. **Health is outside-process**: compose health hits the probe SIDECAR,
   never the served process. A server cannot paint itself healthy.
3. **Secrets are minted on the target** (0600, idempotent, never printed);
   per-lane `bksk_` keys via the admin API; test keys get revoked, never
   left behind.
4. **No host-path deploys**: hub containers mount git-pulled volumes.
5. **One version law**: the stack `version:` ref pins buckle + suspenders +
   belt for every hub; never deploy a floating ref.
6. **Destructive steps** (boot-out, rm of plists, reclaim of infra) get a
   recoverable snapshot first (C85) and an explicit event.
7. **Docker on NAS lives at `/usr/local/bin/docker`** (not on
   non-interactive PATH); compose streams via scp -O.

## SKILLS first

`docker`, `fleet-install` for install/wire surfaces, `ship` for the
pre-launch checklist.

## EXIT

`hubctl status <hub>` green through the sidecars, receipt banked on the
item, zero secrets in output.
