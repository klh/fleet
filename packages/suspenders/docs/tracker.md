# fleet-tracker — tracker-style lane sidecar (W575)

A read-only terminal view of live fleet lanes, Polyend-Tracker-style: lanes
occupy columns, chronological transitions flow top→bottom, and compact cells
(`W575▶`) carry the work-item id plus one glyph per state.

## Run it

    bun ~/.claude/hooks/suspenders/bin/fleet-tracker.ts        # live TUI
    bun ~/.claude/hooks/suspenders/bin/fleet-tracker.ts --once # one frame, pipe-safe
    fleet-tracker --project /path/to/repo/.git                 # one project's graph

Installed by the canonical installer (`bash install.sh`), which publishes the
`fleet-tracker` PATH shim next to `coord`/`work`/`dispatch` — one surface for
every harness (claude, codex, copilot, cline) and plain shells.

## Keys

| key | action |
| --- | --- |
| `↑↓` / `j k` | move the row cursor (newest at bottom) |
| `←→` / `h l` | move the lane cursor (window slides on narrow terminals) |
| `enter` | inspect the cell's permanent completion summary |
| `r` | force a snapshot resync |
| `q` / `ctrl-c` | quit (terminal fully restored) |

## Data: the canonical surfaces, nothing else

The tracker runs SELECTs over the same tables the board GUI reads —
`work_items`, `claims`, `sessions`, `facts`, `events`,
`work_completion_records` — through the same store port the coord CLI uses
(`openStore`, honoring `GOVERNOR_STORE_URL`). Push updates ride the
production bus socket (`/subscribe`, the same socket `coord subscribe`
rides). Snapshot reconciliation on every (re)connect re-reads the canonical
timeline, so a reconnect preserves ordering and recovers missed events by
event id — no gap, no second ledger, no CLI-display parsing, zero writes.

## Status vocabulary (one glyph per state — colour is additive)

    · queued   ◇ claimed   ▶ running   ? decision   ✓ complete   ✗ failed   ! stalled   ~ unknown

- **running** = a registry row (`​.fleet/lanes.json`) whose process verdict
  (`laneAlive`) is live, or a fresh claimant transcript.
- **stalled** = claimed, not live, past the 15-minute reclaim lease.
- **unknown** = the verdict is genuinely undecidable from the host's
  evidence (no registry row, no fresh transcript). The tracker never guesses.
- **testing** is deliberately absent: no canonical event kind or work-item
  state marks it today. The tracker invents no second-ledger signal; when
  the fleet grows one, `KINDS` in `hooks/tracker/model.ts` maps it.

## Terminal integration (Copilot investigation result)

There is no supported native GitHub Copilot CLI extension surface for
embedding a persistent external TUI pane: Copilot CLI integrates as a
harness command (agent/prompt surfaces), and `gh` extensions are separate
executables — neither embeds a terminal UI. So the tracker runs BESIDE any
harness CLI in a terminal split (tmux/iTerm panes), which is exactly the
owner request. No vendor-specific private UI hooks are used — plain ANSI
only (alternate screen + cursor addressing), works in any terminal
emulator.
