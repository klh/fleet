# W2592 — native CLI/LLM inter-agent message protocols vs mechanical ack anchoring

Status: design row (evidence-gathering + recommendation, 2026-11-03). Scope:
ONE design document; no coord-plane rewrite (the item's explicit bound).
Evidence = code reads with file:line + live governor.db queries taken
2026-11-03 ~08:30–09:10 UTC.

## 0. The owner's question

User (2026-11-03, live session): "some talk between sessions is not reacted
to as it should — should we support cli/llm message protocols as well to
natively do cross-talks? many do support it — also if not then can we anchor
it more mechanically?"

Two candidate paths: (1) adopt native per-CLI message protocols so a
directed event interrupts the target's turn loop; (2) make unacted directed
events mechanically blocking (stop-gate refusal, ack leases, escalation).

## 1. What the fleet already has (survey)

### 1.1 Delivery surfaces — FIVE render paths, ONE durable row

| # | Surface | Fires when | Reach |
|---|---------|-----------|------|
| 1 | WS push tail (`WS INBOX +n`) — `hooks/gates/push.ts:84` | every tool call | model context, advisory |
| 2 | Files-gate drain (`coord-inbox:`) — `hooks/gates/files.ts:228` → `hooks/lib/lanes/lane-inbox.ts:49` | every file save | model context, advisory, MAX_DRAIN=5 |
| 3 | Ask-gate drain (W861) — `hooks/gates/ask.ts:124` | every user prompt | model context, advisory |
| 4 | Stop-gate turn-boundary block — `hooks/gates/stop.ts:134` → `hooks/lib/gates/turn-boundary.ts:79` | turn end (Stop hook) | **blocking** (claude dialect only) |
| 5 | Manual `coord inbox` / `--ack` — `hooks/coord/bus.ts:511` | lane-initiated | operator/human |

Every path renders from the same durable state: `events` (row per directed
event) + `direct_message_receipts` (`QUEUED → SEEN → ACCEPTED`,
`govdb-open.ts:56`). A render (1–3, 5) marks SEEN; only an explicit
`coord ack <id>` (or `inbox --ack`) marks ACCEPTED.

### 1.2 Native injection — exists for exactly TWO harnesses

**claude (managed runtime)** — full native interrupt surface, fleet-owned
(`hooks/bin/claude-runtime.ts`):
- stream-json stdin is a control channel: `control_request
  {subtype:"interrupt"}` aborts the in-flight turn (`claude-control.ts:160-197`);
- the runtime then injects the event as a `user` frame in the SAME
  conversation (`claude-control.ts:66-73`);
- wake bridge: subscriber writes a pending claim file
  (`claude-wake.ts:61`), the runtime claims/proves it
  (`claude-wake.ts:108-194`), proof = the injected turn's RESULT frame
  (W1035.1.1);
- urgency split (W1035.1.1): routine notes WAIT for the turn boundary
  (`control.boundary()`, `claude-runtime.ts:201`); only `urgent:"1"` events
  may abort mid-tool (`claude-wake.ts:45-54`).

So for managed claude lanes the fleet ALREADY speaks a native protocol:
`coord steer` → wake claim → interrupt/inject → proof. There is nothing
external to adopt — claude-code's own SendMessage/interrupt surface IS this.

**codex** — app-server JSON-RPC (`hooks/lib/executors/codex-steer.ts`):
- `thread/read` → `turn/steer {expectedTurnId, input}` steers the active
  turn (`codex-steer.ts:84-88`); managed lanes serve it on a per-lane unix
  socket (`codex-direct-delivery.ts:41-56`);
- delivery states: `steered | queued | unsupported | ignored` — a steer
  receipt is transport delivery, NEVER an ack (`codex-steer.ts:46-47`);
- detached `codex exec` lanes have no turn to address
  (`codex-steer.ts:1-3`) → durable inbox is the only transport.

**copilot / grok / cline / forge** — no native interrupt surface
(`hooks/lib/executors/*.ts`, no steer/wake wiring; registry
`registry.ts:27-34`). Durable inbox + renders 1–3 only.

### 1.3 The gap is not transport — it is REACTION enforcement

The coordinator-facing leg is the weak one. Root directives #103904–#103949
(target = the fleet coordinator session `1a7d8e07…`, root's live session
`01a186a5…`): 8 of 11 NOTEs reached SEEN and then sat UNACKED through
multiple turn boundaries — the stop-gate drain (surface 4) exists for lanes
but the coordinator's session is interactive (root's own CLI), where the
Stop hook did fire but the queue kept refilling faster than root acked.

## 2. Live evidence (governor.db, 2026-11-03)

- **Ack latency, 48h, n=782 accepted**: p50 = 147s · p90 = 36m ·
  p99 = 3.3h · max = 852m. Half of all directed events wait ≥2.5 minutes;
  one in ten waits over half an hour.
- **#103663 "delivered twice" (W2267.6 lane)**: the event row exists ONCE,
  its receipt row ONCE, its subscribe-log line ONCE (`coord-subscribe-
  autow2267-6….log`, grep = 1 hit). What the lane experienced was the SAME
  durable row rendered again by a different advisory surface (push tail →
  files drain → inbox read) before an ack landed. Render duplication, not
  transport duplication. (`_all` log: 9 event ids appended twice across
  subscriber reconnects — bounded, untargeted, cosmetic.)
- **Unacked backlog**: oldest non-ACCEPTED receipt is 15 days old; 429
  QUEUED rows target one long-dead coordinator session (`53eb333b…`,
  gaps project) with no expiry, escalation, or sweep.
- **Dialect skew**: the root-worker codex session (`01a186a5…`) holds
  55 QUEUED + 22 SEEN receipts up to 21h old — codex has no Stop hook, so
  surface 4 never fires for it; surfaces 1–3 are advisory and only land on
  its next tool call.

## 3. Path A — adopt more native protocols

**What it would mean.** Generalize the steer transport: one
`InterruptTransport` per adapter with `canInterrupt(lane) → boolean` and
`inject(lane, event) → delivered|queued|unsupported`, registry-declared
beside `managedRuntime`, dispatch/federation refusing "native" claims for
adapters without one.

**Findings.**
- The two CLIs that matter (claude managed, codex app-server) are DONE
  (§1.2) — including boundary-wait, urgency, and delivery proof. Path A is
  already implemented where a protocol exists to adopt.
- The remaining surfaces (copilot, grok, cline) expose no documented
  turn-interrupt/inject API. Adopting "many CLIs' protocols" would mean
  N bespoke bridges with exactly the divergence the executor registry was
  built to remove — high cost, and the evidence in §2 says the misses are
  not transport failures: events ARE delivered (SEEN), they are not ACTED
  on (no ACCEPTED).
- Native injection cannot reach the worst offender — an INTERACTIVE root
  session — because the fleet does not own that stdin; only the operator
  does.

**Verdict on A: closed as complete-where-possible.** Extending it buys
nothing for the observed failures.

## 4. Path B — mechanical anchoring (RECOMMENDED)

Make "directed event delivered but not acted on" a first-class, observable,
eventually-escalating state instead of a passive receipt row.

Three independent, individually-shippable legs:

**B1. Ack lease with expiry (the mechanical core).**
`direct_message_receipts` gains lease semantics: SEEN sets a deadline
(`lease_deadline`, default e.g. 30m, config-over-code in the coord config);
the ONE fleet-loop maintenance task the plane already runs sweeps expired
leases and (a) emits a `coord.ack-overdue` NEED_DECISION to the SENDER
(the coordinator learns their directive was ignored — today they never do),
(b) after a second window, marks the receipt `STALE` so it stops counting
as pending for the recipient (unblocks §2's 15-day backlog and dead-session
QUEUE rows) while the row stays auditable. Dead sessions' receipts sweep
on session state, not time (the 429-row case).

**B2. Stop-gate anchor for every dialect (close the codex hole).**
The turn-boundary block (`turn-boundary.ts:79`) renders via a Stop hook
claude sessions run. Codex lanes need the same refusal at their turn end —
the adapter-declared surface (a `stopHook` install step in dispatch, or the
managed codex runtime checking pending receipts before exiting its loop).
Bounded: refuse at most N=2 times per event (lease from B1 bounds it), so
a truly-unable lane is not wedged forever — the wedge becomes an escalation
instead (B1).

**B3. Sender-visible unacked counter (make silence observable).**
`coord emit NOTE/NEED_DECISION` already prints the event id; extend the
emit tail (and `coord fleet`/`work report` CONSULT column) with the
target's pending-unacked count and oldest age at emit time — the sender
sees "target has 7 unacked, oldest 41m" BEFORE deciding to steer again.
Root's repeated "acknowledge each only after acting" directives are this
information gap: today the sender has no cheap read of "was I heard".

**Why B over A.** The failure mode is unacted SEEN rows, not undelivered
events. A cannot fix that (injection ≠ ack, by codex-steer's own contract
`codex-steer.ts:46-47`); B makes the state impossible to sit in silently:
recipients get a bounded block, senders get an observable counter, and the
plane gets an escalation that reaches a human exactly when a directive
truly died.

## 5. Recommendation

**B, in order B3 → B1 → B2.** B3 is a pure read-side change (hours);
B1 is the mechanical core (one migration column + one fleet-loop task);
B2 is the only leg that touches dispatch and lands last. A is closed:
native cross-talk already exists for every harness that supports one, and
the evidence says more transports would not have saved #103904–#103949.

Estimated B1+B2+B3 as three separate items (mechanically independent);
this document is the shared design row they cite.

## 6. Evidence index

- code: `hooks/bin/claude-runtime.ts` · `hooks/lib/executors/claude-control.ts` ·
  `hooks/lib/executors/claude-wake.ts` · `hooks/lib/executors/codex-steer.ts` ·
  `hooks/lib/executors/codex-direct-delivery.ts` · `hooks/gates/push.ts` ·
  `hooks/gates/files.ts` · `hooks/gates/ask.ts` · `hooks/gates/stop.ts` ·
  `hooks/lib/gates/turn-boundary.ts` · `hooks/lib/lanes/lane-inbox.ts` ·
  `hooks/coord/steer.ts` · `hooks/coord/bus.ts` (cmdInbox/cmdAck) ·
  `hooks/lib/govdb/govdb-open.ts:56` (receipts schema) ·
  `hooks/lib/executors/registry.ts`
- governor.db (2026-11-03): latency histogram (782 accepts, 48h) ·
  #103663 single-row proof · unacked backlog per sid ·
  #103904–#103949 receipt states · subscribe-log duplicate scan (`_all`:
  9 ids ×2 from reconnect replays)
