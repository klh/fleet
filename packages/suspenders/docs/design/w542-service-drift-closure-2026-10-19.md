# W542 — watchdog effective service manifest versus launchd runtime drift (2026-10-19)

Mission (from the item): detect expected installed services absent from the
exact current launchd domain, deriving expectations from explicit installer
activation receipts (manifest presence alone is not activation intent), and
classify each service — unloaded, loaded scheduled-idle, resident
starting/running/degraded, disabled, unknown/inspection failure. Loaded
arguments and canonical rendered definitions must match, port listener
ownership must be verified, and a hand-launched healthy server or stale
loaded label must not satisfy supervised-service proof. Read-only
NEED_DECISION/BROADCAST output, deduped findings, bounded recheck; no
automatic restart, kill, or bootstrap during active sessions.

**Resolution: landed as `packages/suspenders/scripts/lib/service-drift.ts`
(+ `service-drift.test.ts`), merged to main before this lane's close — the
watchdog imports it (`scripts/dispatch-watchdog.ts`), and the branch
baseline→head diff carries only this closure record.**

Mechanics (`scripts/lib/service-drift.ts`):

- `ActivationReceipt` (`fleet.service-activation.v1`, darwin, `gui/<uid>`
  domain) is the sole activation intent — strict per-service validation
  (label shape, absolute unit path + sha256, non-empty argument array,
  resident flag, optional port/generation hashes).
- `retainActivation` carries prior validated intent across failed/omitted
  re-registration; `writeActivation` publishes atomically (0600 temp +
  rename, re-validated before publish, prior intent survives failure).
- `inspectServices(receipt, domain, manifest, …)` classifies per service:
  wrong receipt domain → `unknown` (a receipt for another domain cannot
  prove activation); canonical manifest digest mismatch → `drift`;
  generation payload integrity failure → `drift`/`unknown`;
  `launchctl print-disabled` override → `disabled`; recorded unit bytes
  differ from receipt → `drift`; absent from the exact domain → `unloaded`
  (inspection failure stays `unknown`); loaded without PID (scheduled jobs)
  → `scheduled-idle`; loaded arguments mismatch → `drift`, so a stale
  loaded label plus a manual healthy listener is NOT supervision; periodic
  invocation failure → `degraded`.
- Listener ownership via `OwnershipDeps`/`stableDescendant`
  (`lib/owned-process.ts`): the supervised descendant must own the port —
  PID reuse, reparenting, or a listener replacement during inspection stays
  `unknown`; a legitimate launchd PID replacement between observations
  raises no notification.
- Absolute `/bin/launchctl` for every inspection (outside-process law);
  findings dedupe and recheck once per bounded reminder interval;
  recovery is broadcastable, never automatic.

Coverage (`scripts/lib/service-drift.test.ts`, 21 tests): optional services
not inferred from manifests, scheduled-idle without PID, wrong-domain
receipts, disabled overrides, stale-arguments + manual listener rejection,
unit/manifest drift, unknown on inspection failure, legitimate PID
replacement silence, dedupe/bounded recheck, atomic receipt publication,
current declaration defeating an old-generation receipt, stable child
listener ownership, child PID reuse/reparenting rejection, and outside-
process launchctl paths.

Verify (2026-10-19): `bun test scripts/lib/service-drift.test.ts` →
21 pass / 0 fail in this worktree at `adc1ec95`.

Live audit (2026-10-15, from the lane capsule): the W501 buckle spoke
(`com.suspenders.buckle-spoke`) was loaded with PID 51738 matching :4101 —
resident running, no drift finding. Deliberate KeepAlive revival and full
tool-use/result/follow-up escalation remain open maintenance work, tracked
by the item description, not this closure.
