# W484 — NAS DSM 7.4.1-90080 major upgrade: owner decision + runbook

2026-10-07, lane `autow484-p98b319584008df14`. Decision-pending ops item: the
NAS wants a **human-confirmed** DSM major upgrade. Nothing in the fleet can or
should press the button — this doc records the state, the decision the owner
owes, and the exact procedure for when they press it.

## State (observed)

- `synoupgrade` prechecked **DSM 7.4.1-90080** (from 7.3.2-86009) and the
  scheduled 00:00 poweroff cut the flow before any human-confirmed apply.
  The NAS is NOT mid-update: it rebooted clean and is serving.
- Live corroboration 2026-10-07 (`hubctl status nas`): belt/board/buckle/store
  containers `running`, health sidecars :7790/:7800/:4112/:7794 all `200`.
  `buckle-ready :4113` reads
  `000` — pre-existing on this hub (synthetic readiness sidecar from W467,
  not yet serving there), **not** caused by the update event.
- Why DSM refuses to self-apply:
  - update channel is **not** AutoUpdate (manual updates only);
  - soft check `DroppedSupportPackages` — some installed package(s) have no
    7.4-compatible build and will be dropped/need replacement;
  - soft check `MightNeedRepairPackages` — Container Manager packages
    (the fleet hub containers) may need a repair pass after the jump.

## Decision owed (NEED_DECISION filed)

Owner GO, plus a window. Options:

1. **GO now** (default recommendation): containers are stateless
   self-healers (`restart: unless-stopped`-equivalent via compose), hub
   state lives in git-pulled volumes. Pick any evening; expect
   **10–30 min total outage** and **at least one power-cycle**.
2. **GO after W483** (hub quiet-hours poweroff window 00:00–08:00) lands:
   then the power-cycle lands inside the quiet window by construction.
   Zero extra coordination, but the DSM human-confirm step is a GUI act —
   it cannot ride the quiet window unattended.

Either way: **do not schedule during an active dispatch fan-out** — lanes
riding the NAS buckle front drop mid-brief.

## Pre-flight (before pressing GO)

1. Config backup: Control Panel → Update & Restore (or `synoconfbkp` /
   Hyper Backup of config only) — the 7.3→7.4 jump rewrites system config.
2. `docker ps --format '{{.Names}}'` inventory + `docker volume ls` on the
   NAS — know what should come back.
3. Confirm no lane fan-out is running (`coord fleet`).
4. Optional but cheap: `hubctl render nas` diff in a scratch dir to have
   the expected compose shape on hand for post-compare.

## Apply (owner, Control Panel)

1. DSM GUI → Control Panel → Update & Restore → DSM Update → the
   prechecked 7.4.1-90080 row → **Upgrade now** (manual confirm is the
   whole point of `Not AutoUpdate` + the soft checks).
2. Let it run to completion: expect reboot(s); do NOT pull power.
3. If Package Center flags packages for repair/reinstall afterwards, do
   that pass before re-deploying anything (`MightNeedRepairPackages`).

## Post-flight (verify, in order)

1. Containers self-heal: `bun packages/suspenders/deploy/hubctl.ts status
nas` — expect belt/board/buckle/store `running` + sidecars `200`.
2. `docker ps` on the NAS — no restarted-in-crash-loop containers.
3. Package Center: no "needs repair" badges (or repair done).
4. `coord fleet` + one lane probe (any `dispatch`) riding the NAS front to
   prove the serving chain end-to-end.
5. Re-check `buckle-ready :4113` against its pre-upgrade baseline (`000`
   today; anything ≠ baseline is new signal, not update damage).

## Rollback posture

DSM major upgrades are one-way on-device. Back-out = restore config from
the pre-flight backup; data volumes are untouched by the updater. Fleet
side is re-deployable from git at any pinned `version:` via
`hubctl deploy nas` on a 7.3.2 reversion device or replacement unit.
