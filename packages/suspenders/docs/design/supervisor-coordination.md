# Supervisor coordination (W977.1)

A supervisor at a decision point (shared work, claims, capacity) fires a
**bounded peer round** through `coord coordinate`; peers answer via the
standard `consult-reply` flow and the asker drains answers with the standard
bounded wait (`coord wait --kinds consult.answer`). No schema change: the
topic rides the durable question text.

## Wire format

    coordinate/<topic>: <note>          topics: work | claims | capacity

`supervisor-coordination.ts` exports `questionFor`/`topicOf` as the one
parser; consumers (singleflight, `/api/outbox`, the W977.2 benchmark scorer)
never re-derive it. The topic rides the question text — no new table, no new
event kind: consults + `consult`/`consult.answer` events carry the round.

## Bounds (the binding contract)

| knob (env, config-over-code)        | default | meaning                          |
| ----------------------------------- | ------- | -------------------------------- |
| `SUSPENDERS_COORD_MAX_PEERS`        | 2       | fan cap per round (hb-desc)      |
| `SUSPENDERS_COORD_RATE_WINDOW_MS`   | 60000   | rate-cap window                  |
| `SUSPENDERS_COORD_RATE_MAX`         | 3       | distinct rounds per asker/window |

- **Singleflight**: one OPEN round per (asker, topic); a repeat ask REPLAYS
  it — herd control per the W934.1 federation contract. Replays never
  consume the rate cap.
- **Fan cap**: peers = RUNNING sessions of the project, asker excluded,
  external connectors excluded (this is the LOCAL supervisor plane; W931's
  HTTP ingress carries externals), paused lanes excluded (the facts pause
  row is the pause source of truth). Most-recently-active first.
- **Rate cap**: on hit → die with the knob name (exit 2), the operator
  raises the knob.
- **W923 parity**: a refused round (no live peers) still events — the board
  and inbox readers see the refusal, not silence.
- **Deadline**: every consult is deadline-stamped (the shared 1h
  consult-expiry contract); dropped peers cost nothing — the W977.2 verdict
  keeps the transactional claims ledger as the backstop.

## Kev rides OUTBOUND only (`--classify`)

With `--classify` the trigger asks the typed-decision specialist (ask vs
skip) ONCE before minting; every failure degrades open (the local bounds
decide). Never on receive: an inbound consult is answered via consult-reply
and never fires a round reflexively — no coordination loops.

## Driver cadence (W977.2 verdict, folded in)

Matched-arm discipline from the benchmark lane: **one combined
claims+capacity ask per decision point**, retry budget 2 (a replay is not a
retry — only a fresh round after the OPEN one closes counts), and the
transactional claims ledger is the backstop when consults drop. The trigger
is a tool the driver calls at explicit decision points; there is no ambient
loop and no auto-fire.

## Faces

- mint: `coord coordinate --topic <t> --note "..." [--max-peers n] [--classify] [--json] --as <sid>`
- answer: `coord consult-reply <C##> "<answer>" --as <peer>`
- drain: `coord wait --kinds consult.answer --as <sid> [--max-seconds n]`
