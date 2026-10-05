# Fleet Board for VS Code

The klh agent fleet inside VS Code — the user-perspective face of the fleet
board (`:7799`): live work items, OPEN decisions and a status pill, fed by
the board's v3 read API
(`packages/suspenders/docs/board-api.md`).

## Views

- **Tasks** — every live work item grouped by project: `W7 ◐ title` with a
  state glyph (▶ ready, ◐ claimed, ● running, ⊘ blocked, ⊞ shattered),
  owner, age and open-decision count in the description line. Click a task
  for the detail document (state, owner, lane tail, decisions, bus events).
- **Decisions** — the OPEN decision feed; click to jump to the owning item.
- **Status bar** — `$(radio-tower) fleet <n> tasks · <m>?` pill; warning
  colors when the board is unreachable.

## Config

| setting             | default                 | what                                     |
| ------------------- | ----------------------- | ---------------------------------------- |
| `fleet.boardUrl`    | `http://127.0.0.1:7799` | board base URL (LAN name for remote)     |
| `fleet.pollSeconds` | `15`                    | poll interval; `0` disables auto-refresh |

## Dev

    bun test
    bun pack.ts   # build + vsix → dist/fleet-board-<v>.vsix

Install: `code --install-extension dist/fleet-board-<v>.vsix`. The board
itself runs via launchd or
`bun packages/suspenders/hooks/bin/fleet-board.ts`. Reads are unauthenticated
on the loopback perimeter; the extension is read-only — writes (answer, ack,
start, ship) stay on the board behind its write token.
