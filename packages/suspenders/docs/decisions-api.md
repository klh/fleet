# decisions contract — board v2.5 (2026-09-25, owner directive)

Authoritative interface between the decision lifecycle (fleet-board.ts), the
UI (fleet-board-html.ts), and the agent health layer (monitor.ts). If code
and this document disagree, fix the code or amend this file in the same commit.

## Decision record (SQLite, board-owned `decisions` table)

| column        | meaning                                                      |
|---------------|--------------------------------------------------------------|
| id            | INTEGER — the source NEED% event id (globally unique)        |
| project       | TEXT — project identity of the asking lane                   |
| task_id       | TEXT — work_items.id from payload.work, else NULL (never guessed from free text) |
| asked_by      | TEXT — sid of the asking lane                                |
| question      | TEXT — payload.note (plain language, shown verbatim)         |
| options       | TEXT — JSON array of {label, tradeoff} from payload.options, else [] |
| state         | TEXT — OPEN \| ANSWERED \| ACKNOWLEDGED \| CANCELLED \| SUPERSEDED |
| delivery      | TEXT — DELIVERED \| FAILED (did the lane ack pickup; FAILED shows in UI as "delivery failed — retry", or as the owner-ruling prompt when owner_actionable) |
| answer_note   | TEXT — the human's answer                                    |
| answer_to     | TEXT — sid the answer was addressed to                       |
| answer_token  | TEXT — uuid rotated on every state change; POST /api/answer must carry the token the client read (multi-tab + stale protection) |
| created_ts / answered_ts / ack_ts | INTEGER ms epoch                          |

GET /api/decisions → { ts, decisions: [ …record + age_s, task_title (joined
from work_items when task_id set), asked_by_label ] }. Decision ids are
globally unambiguous (event id + project in the record).

Freshness (W798): /api/decisions recomputes per call — sync + records are
never served from a TTL memo; only /api/data rides the feed memo. A fork is
visible on the next GET after its emit; an answer lands on the next GET
after the POST. Consumers that POST-then-GET rely on this.

## Id contract (W667 — one name on the wire)

`id` is THE decision id everywhere on the wire: GET /api/decisions emits
`id`; POST /api/answer consumes `id` (the legacy alias `forEvent` is
accepted and MUST carry the same value). All of them are the store event
id — the `decisions.event_id` column, and the `decision` field the ANSWER
bus event records. The SQLite column keeps its legacy name; the API never
exposes `event_id`.

## W667 target-liveness classification

Each record carries `owner_actionable` + `owner_reason` ("owner-needed" |
"target-dead"). W667: "target-dead" reads the process-backed lane registry
(the `work lanes` surface — lib/lane-liveness.ts verdicts: recorded pid
alive with anchored harness args, or transcript fresh in the 15-min lease)
with the sessions face as the fallback for unregistered targets;
`unknown` never reads dead. The board auto-classifies stale-lane
decisions — no human notices required — and /api/answer routes them to
recordOwnerRuling without a lane ack.

## W798 duplicate collapse + class rulings

Forks whose question names the same subject — the longest path/dotted-key
token (≥3 "/" segments or ≥3 "." parts, `:digits` stripped) — and same
project collapse: the newest OPEN event is the primary card, members carry
`dup_of: <primary id>` and are hidden from the OPEN feed (the client
renders them under the primary's "+N like this" badge), primary carries
`dup_count: N`. Records of one compute are the collapse input. Resolve the
class with ONE ruling: POST /api/answer with `ids: [primary, …members]`
applies the ruling to every OPEN member per-id (each gets its own ANSWER
bus event; per-member tokens are NOT required — the write token guards the
route, the answer token is stale-protection for the single-card path).
Members answered by id alone (legacy path) answer under the old rules.
Resolved rows render resolved in &history=1.

## State machine

OPEN → ANSWERED (human sends; POST /api/answer idempotent: same token+note
replays return 200 {ok:true, replay:true}; stale token → 409 {error:"stale"})
OPEN → ANSWERED as OWNER RULING (W487): a fork whose source event carries
`classification: owner-needed`, or whose target session is not RUNNING, never
dead-ends on Send-to-lane — the board renders it owner-actionable (record
fields `owner_actionable: true`, `owner_reason: "owner-needed" | "target-dead"`)
and POST /api/answer captures the ruling directly: an ANSWER event on the bus
with `ruling: owner` + `decision: <id>` and NO lane target, answer_to kept as
the raw stored addressee. The decision resolves without a lane ack (no
ANSWERED → ACKNOWLEDGED transition is possible — the addressee is gone by
definition).
OPEN → CANCELLED (asking lane supersede/cancel event; NOT by board dismiss;
linked task DONE — the work graph already decided, ages out on the next
sync with the token rotated, W798)
ANSWERED → ACKNOWLEDGED (lane inbox sees the ANSWER and the lane's next
checkpoint/message references it — best-effort heuristic, monotonic)
Never: dismiss/ack of the NOTIFICATION resolves a decision. The board's
dismiss button on a card = CANCELLED and asks for confirmation.

## Advise (W667)

POST /api/advise {id} queues hooks/bin/advise.ts and returns
{ok:true, started:true}, {ok:true, queued:true} or
{ok:true, started:false, inFlight:true}. The board runs one advice panel at
a time because the pinned local model has two shared slots. The fact
`advice.<id>.requested` records `queued` or `running`; /api/decisions exposes
it as `advicePending`. The worker clears the stamp on a terminal write and
the board records an error if the worker exits without one. Transport
failures back off 2s/4s/8s, with three automatic retries; a terminal
advice or error fact ends the spinner.

POST /api/decisions/<id>/evaluate returns 202 with `startedAt` immediately.
GET /api/decisions/<id>/evals returns saved evaluations and a `status`
(`running`, `startedAt`, `error`). The browser polls until the model finishes;
the model call never holds the HTTP response open through a proxy timeout.

## Agent health

A session with an OPEN decision addressed to it is "Waiting for you":
monitor.ts excludes it from zombie termination and alerts; `monitor --fix`
may release ITS file locks (ownership-checked, logged) so parallel work
proceeds; resume uses the normal claim/lease path. Board shows it in the
decisions section, not as a stalled agent.

## UI requirements (fleet-board-html.ts)

Persistent "Decisions needed" section above active work — never a popup.
Always one explicit state: loading / "N decisions need you" / confirmed none
("No pending decisions · checked Xs ago") / "decision feed unavailable —
last good update Xs ago" (fetch/render failure is NEVER rendered as zero).
Card: question, project · task · agent, why-required/what-blocks (task title
or "no linked task"), age (readable), options with tradeoffs (selectable ≠
submitting), recommendation (when a fact exists) with rationale + "use"
fills the field, custom answer field, explicit Send — labelled "Record
ruling" on owner-actionable cards (W487: those resolve on the board; a
dead/absent target renders as "target lane is dead or absent — record the
owner ruling", never as a retry offer). Duplicate classes render ONE
primary card with a "+N like this" badge (W798). Unresolved decisions
persist across reloads/restarts (server state is the truth). Badge with
pending count visible when collapsed. Toast once per NEW decision id — never
per poll. Global pending count shown when the view is project-filtered.

## Frontend reliability

No empty .catch(); validate status + payload shape; single in-flight poll
(per-grid: a finished response supersedes, stale ones dropped via ts
compare); on fetch failure keep last good data marked "stale"; drafts,
focus, scroll preserved across renders (keyed nodes); fetch timeouts
(AbortSignal.timeout(8000)) with inline retry buttons; answer errors render
inline on the card; option-select and submit are visually distinct;
"Advice me!" renamed "Get recommendation"; handlers read current data via
keyed lookups (no stale closures); no innerHTML with unescaped data;
decisions come from the decisions table — independent of the truncated
activity feed.

## Layout (dark theme kept)

1 Overall status + connection health (live/stale/error, last good ts)
2 Decisions needed
3 Active tasks + meaningful progress
4 Queued/blocked work (+ failures, waits)
5 Collapsible diagnostics: completed cards, claims (file → owner → waiting
  → lease), raw event stream
Compact fleet summary replaces the badge wall (expandable). Readable times
("4 minutes ago"); liveness ≠ heartbeat ≠ last meaningful progress. Monospace
only for ids/paths/technical; interface text in the UI font. No decorative
controls: Cost/Balanced/Speed etc. stay OUT until a routing subsystem exists.
