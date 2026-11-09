# The consult API layer

Consult is how agents ask each other (and the knowledge plane) questions
without polling. This repo provides the PURE and API layers — the state
machine, the config knobs, and the knowledge-plane answering rules. The
transport and durable state live elsewhere (see "What stays in fleet").

## consult-v2 — the pure state machine

`src/consult-v2.ts` has zero I/O, so it is table-testable. It owns:

- **Delivery class per consult.** `INTERRUPT` — exactly one addressee,
  effective priority high, asker blocked on it: delivered mid-turn, must
  be answered or explicitly deferred. `BTW` — everything else (low/normal
  priority, multi-recipient, broadcast, non-blocking): surfaced at the
  next tool boundary as ONE digest line, no ack required.
- **Priorities** (`high | normal | low`) and the downgrade-only rule: a
  curator's verdict may lower an asker's priority, never raise it.
- **Budget windows.** At most one interrupt per recipient per
  `consult.interrupt.min_interval_s` (default 180 s, bounded 120–300) and
  per sender per `sender_min_interval_s`. Inside the window a second
  interrupt QUEUES and coalesces — one delivery when the window opens —
  it is never downgraded to btw.
- **Routes** — the route grammar: `<sid> | <sid>,<sid> | fleet | hub:<name>`.

## consult-config — the zod knob schema

`src/consult-config.ts` parses a machine-level JSON config (zod, loud on
drift — a malformed config names the error and rides defaults, never a
partially-coerced value). The path is parameterized: fleet's convention is
`~/.config/klh/coord.json`, overridable by `SUSPENDERS_COORD_CONFIG`.

```json
{
  "consult": {
    "interrupt": {
      "min_interval_s": 180,
      "sender_min_interval_s": 180,
      "ack_timeout_s": 180
    },
    "feedback": { "require_on_done": false }
  },
  "steer": { "min_interval_s": 180 },
  "knowledge": { "downvote_threshold": 2 }
}
```

- `consult.interrupt.*` — budget windows above; `ack_timeout_s` bounded
  30–1800.
- `steer.min_interval_s` — the mid-turn steering gate's own interval,
  bounded 60–3600.
- `knowledge.downvote_threshold` — community-signal demotion: at this
  many downvotes a knowledge row never answers a consult, bounded 1–20.

## consult-oracle — trust-tier eligibility

Oracle-first: every consult asks the knowledge plane before any delivery.
A hit that may answer is answered by the plane (`answered_by: knowledge`)
and no agent is interrupted.

Who may answer:

| row state                  | hash check  | tier                            |
| -------------------------- | ----------- | ------------------------------- |
| active                     | verified    | trusted                         |
| candidate                  | not drifted | unreviewed (the reply says so)  |
| drift / retired / rejected | —           | never answers — normal delivery |
| demoted by downvotes       | —           | never answers                   |

Ranking: trusted beats unreviewed, overlap orders within a tier.

Every knowledge answer carries a visible **trust mark** (tier + hash
verification + age) AND a **feedback handle** — the asker is obliged to
report `resolved | failed` with evidence, closing the loop. A miss
returns advisory cards instead; the caller delivers them agent-side.

## What stays in fleet

This repo is the pure/api layer only. These live in the fleet stack by
design and are NOT here:

- **governor store** — the durable consult records, ack state, and
  feedback ledger.
- **session registry** — who is live, and where.
- **WS transport** — push delivery, inbox replay, ack bookkeeping.
- **work graph** — items, claims, dispatch.

This repo ships the pieces any transport can compose: the state machine,
the knobs, and the knowledge-plane answering rules. See
[roadmap.md](roadmap.md) for what is deferred rather than absent.
