# Supervisor coordination benchmark — scenario spec (W977.2)

Deterministic, LLM-optional comparison of three supervisor regimes on
matched work sets, per the parent mission (W977): bounded consultation
among running local supervisors for shared work, claims and capacity,
evaluated against independent supervisors. Supervisors are regime
stand-ins; the coordination plane is a scripted claims/capacity ledger.
No model calls — the live-agent track rides additively later on the same
metric schema.

## Arms (data, not code paths)

| arm | consults | ledger claims | capacity view |
| --- | --- | --- | --- |
| independent | never | never | none (private budget only) |
| coordinated-bounded | 1 combined ask per item, retry budget 2 | yes | waits when full |
| coordinated-unbounded | claims + 2 redundant capacity re-asks per item, retry budget 4 | yes | waits when full |

Arm differences are DATA in `REGIMES` (types.ts); one engine
(`supervisors.ts`) runs all three.

## Matched work set

9 items over 3 supervisors (s1–s3), fixed in `queuesFor` (harness.ts):
3 unique scopes (u1–u3) + 3 shared scopes each appearing on exactly two
queues (sh1: s1+s2, sh2: s2+s3, sh3: s1+s3). Shared scopes are the
double-writer risk (CRASH C4); unique items are the no-conflict control.
`heavy` (pressure scenarios) moves s3's unique item to 3 lanes.

## Scenario matrix

| id | capacity | delivery | isolates |
| --- | --- | --- | --- |
| calm/ok | 4 lanes, demand ≤ budget | ok | base comparison |
| pressure/ok | 4 lanes, demand > budget | ok | oversubscription (A3) |
| calm/drop-first | 4 lanes | first ask per (sid, topic) dropped | retry accounting |
| pressure/drop-all | demand > budget | every ask dropped | worst case: no views, ledger backstop only |

## Cost model

Per unit: consult exchange 120 tok / 4 min latency; blind-claim probe
80 tok / 5 min; duplicate redo 700 tok; thrash multiplier 2× duration
while held lanes exceed budget. All regimes share one cost model
(`COSTS` in types.ts). No RNG: same inputs → byte-identical metrics
(property P6).

## Metric semantics

- **consultCalls/consultTokens** — asks charged to the consult channel
  (retries and redundant re-asks included).
- **consultFailures/consultRetries** — undelivered outcomes and re-asks
  after a drop.
- **claimAttempts/claimConflicts** — ledger claims and refusals on
  foreign claims (C4 probes).
- **yieldedItems** — clean yields on consult truth: foreign claim or
  completion seen, zero work spent.
- **refusedItems** — items refused by the ledger on a blind claim (the
  backstop firing — the probe cost is paid, the double-run is not).
- **duplicateUnits** — items re-run on a scope another supervisor
  already completed (the cost of not coordinating, CRASH C4/S1).
- **oversubEvents / oversubscribedLaneMin** — spawns landing while held
  lanes exceeded the shared budget, and the lane-minutes above budget
  (A3 effort-misspend); capacity is never transactional — the view is
  the only defense, and only for regimes that ask.
- **blockedTimeMin** — consult latency + capacity waits + lost-answer
  waits + claim-probe minutes.
- **thrashMin** — extra execution minutes from contended execution.
- **completedItems/totalItems** — items finished by this regime (dups
  count as completed but flagged).
- **makespanMin** — simulation wall time (max supervisor clock).

## Bench properties (reproduction contract)

A run scores only when all properties hold (harness `checkProperties`):

1. P1 — independent duplicates all 3 shared scopes; bounded arm
   duplicates none.
2. P2 — independent never claims (its signature); bounded arm has zero
   claim conflicts and yields each shared scope exactly once.
3. P3 — bounded asks strictly fewer consults than unbounded at outcome
   parity (dup=0, conflicts=0) — boundedness is measured, not assumed.
4. P4 — on pressure, un-gated regimes oversubscribe (>0 lane-min above
   budget); the bounded regime never does, with no refusals/dups.
5. P5 — injected delivery drops are counted; on drop-all the ledger
   backstop still prevents the double-run (correctness survives;
   efficiency degrades to blind-claim conflicts, capacity compliance
   is lost).
6. P6 — byte-identical metrics on repeated identical runs.
7. P7 — item accounting: every arm × scenario ends with all 9 items in
   exactly one terminal outcome (no lost work).

## Reading the matrix

`bun packages/blam/bench/supervise/harness.ts` prints the comparison
table and exits non-zero if a property breaks. Expected headline:

- independent: 3 duplicate units in every scenario, 30 lane-min
  oversubscribed on pressure, zero consults — pays in double-work and
  thrash, not tokens.
- coordinated-bounded: zero dup, zero conflicts, zero oversubscription
  while delivered, 9 consult calls (1/item) — pays latency for
  correctness.
- coordinated-unbounded: identical outcomes to bounded at 21+ calls —
  boundedness captures the whole coordination gain at ~half the
  consult volume.
- drop-all: coordinated regimes degrade exactly as modeled — no dup
  work (ledger backstop), conflicts reappear (blind claims), capacity
  compliance lost (no view to gate on).
