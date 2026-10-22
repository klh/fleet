---
name: fleet-pulse
description: Read-only fleet pulse — governance mode, live lanes, READY depth, watchdog verdict and recent commits in one render, mutating nothing. Use when asked for fleet status, when starting or finishing a work unit, or before escalating; NOT for switching the governance mode (use the fleet skill for that) or for work-graph mutations.
---

# fleet-pulse

Read-only fleet pulse ($ARGUMENTS — optional: a lane, item id, or tail count).

1. **Governance (read-only)** — `coord governance`: strict (every lane and CLI
   rides buckle keys + suspenders governance; probe-false = refusal) vs solo
   (relents to the belt-direct fallback). Never switch modes here — that is the
   `fleet` skill.
2. **Lanes** — `work lanes --json`: live vs total lanes, items per live lane.
3. **READY depth** — `work ready | wc -l`.
4. **Watchdog** — last 2 lines of `.fleet/dispatch-watchdog.log` (lib-parity,
   fleet-loop pid, lane probe, memory verdict). A FAIL/GUARD verdict or
   fleet-loop churn: surface prominently and probe further.
5. **Recent commits** — `git log -3 --oneline`.
6. **Verdict** — close with one line: healthy, or what needs eyes.

## Gotchas

- Keep renders bounded — per-sid payload loops once made a board API take a minute (W663 payload storm); aggregate, don't fan out.
- WS feed ids are not event ids: the inbox hook numbers its own lines and a replay fakes live churn — check the events-table timestamp.
- `work report` is the ONE supervisor table (item/TOKENS/CACHE/OUT-MIN/AGENT/…); never hand-roll a Markdown status list beside it.
