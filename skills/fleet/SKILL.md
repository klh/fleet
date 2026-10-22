---
name: fleet
description: Use when switching the governance mode (strict/solo) or when a full fleet read is asked — governance mode, lanes, READY depth, watchdog verdict, recent commits in one render. Read-only status asks without a mode change belong to fleet-pulse.
---

Fleet governance check ($ARGUMENTS — optional mode: `strict` or `solo`).

1. If a mode argument was given, run `coord governance $ARGUMENTS` and say the mode changed. If the argument is anything else, treat it as read-only.
2. Run `coord governance` and report the mode (strict = every lane and CLI rides buckle keys + suspenders governance, probe-false = refusal; solo = relents to the belt-direct fallback).
3. Render the fleet pulse in one block:
   - `work lanes --json` → live lanes vs total, items per live lane
   - `work ready | wc -l` → READY count
   - last 2 lines of `.fleet/dispatch-watchdog.log` (lib-parity, fleet-loop pid, lane probe, memory verdict)
   - the three newest commits (`git log -3 --oneline`)
4. If the watchdog shows a FAIL/GUARD verdict or fleet-loop churned, say so prominently and probe further; otherwise close with the one-line fleet verdict: healthy or what needs eyes.

## Gotchas

- Never reconstruct live state from /tmp files or Markdown ledgers — query the plane: `coord fleet` (sessions + claims), `work lanes --json` (liveness).
- WS feed ids are not event ids: the inbox hook numbers its own lines and a replay fakes live churn — check the events-table timestamp before acting.
- Never raw sqlite3 on governor.db; supported CLIs + board API only — a missing verb is a tooling gap, not an invitation to hand-roll SQL.
- For a peer answer, use `coord consult <sid> "<question>" --as <asker>`.
  Copy the exact SID from `coord fleet --json` (`lanes[].sid`) or `[sid=...]`.
  `HEAD` is a Git commit. An unresolved recipient needs discovery and retry
  or an explicit blocker; a broadcast is never a substitute. Inline @mentions
  in broadcast text create neither a directed interrupt nor a consult.
