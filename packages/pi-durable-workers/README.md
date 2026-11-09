# @klh/pi-durable-workers

Registration + heartbeat patterns for long-lived remote pi-durable drivers
(W2888). A worker announces on connect/change and refreshes on an interval;
both operations are **hub-dark tolerant** — a registration failure reports
as a non-ok event, never an exception, so the loop keeps running through a
dead or stale coordination plane.

- `src/registration.ts` — the announce payload (`WorkerAnnouncement`) in the
  shape agreed with W2886's `worker_registrations` table / `coord workers
  register` verb, plus a CLI-backed `RegistrationClient`.
- `src/heartbeat.ts` — `WorkerHeartbeat`: announces on `start()`, re-registers
  every `intervalMs`, and exposes `announceChange()` for out-of-band
  updates (state/task changed) ahead of the next tick.

Deliberately not a pi-durable `Task`: there is no checkpointed progress
worth surviving a crash here — a stale registration row ages out and the
hub's own GC reaps it (a hub-side concern, not this package's).

See `docs/design/pi/fleet-cockpit-tui.md` §4 and §9 item 3 for the wider
registration contract this fits into.
