# Desktop runner carrier (muramasa Docker Desktop) — hardened MVP

Owner-sanctioned runner home after the NAS nightly-shutdown ruling (kb#6774,
NAS dark 24:00–07:00; W2871 NAS pilot on integration-HOLD per review
#117749/#117941). This carrier is the always-on candidate while the Mac is on
AC; overnight window = parked-digest lifecycle (W2869 design).

## Files

- `runner.ts` — W2871 source + `BUCKLE_TOKEN` scoped-key fix (legacy
  `BUCKLE_ROOT_KEY` env still accepted so old runs don't break; new
  deployments carry lane keys only, root key never enters the container).
- `receipt.json` — bounded run receipt (receipt_version 1) from the live
  hardened smoke: digest-pinned image, uid 1000, read-only rootfs, caps,
  TTL key minted outside the container + early revocation, exact-match task
  validation, explicit `not_claimed` list.

## Reproduce

    KEYID=$(…)  # mint via coord lane-key verb once it lands; today:
                # ~/.pi/agent/bin/lane-key mint-file <name> <path>   (0600, TTL variant pending CLI)
    docker run --rm \
      --user 1000:1000 --memory 512m --cpus 0.5 \
      --read-only --tmpfs /tmp:rw,size=64m,noexec,nosuid \
      -v "$PWD/runner.ts":/app/runner.ts:ro -v "$PWD/state":/state \
      -e BUCKLE_TOKEN="$LANEKEY" -e HUB_URL=http://host.docker.internal:4111 \
      -e RUNNER_MODEL=glm-5.3-flash -e TASK_BRIEF="<task>" \
      oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 \
      bun /app/runner.ts
    ~/.pi/agent/bin/lane-key revoke <keyid>   # or let the 900s TTL lapse

## Not claimed

Durable interrupt/resume, authorization/lease fencing, seed-digest promotion —
W2869/W2869.2/W2865 own those; this item is the carrier + receipt proof only.
