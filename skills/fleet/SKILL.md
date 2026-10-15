---
name: fleet
description: Fleet governance + pulse — show or switch the governance mode, then render the fleet state (lanes, ready, watchdog, commits)
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
