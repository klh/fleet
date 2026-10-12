# W653 — W652 shatter plan: executed (record)

W653 was minted as the plan item for the W652 shatter (three independent
consolidation scopes). The shatter materialized under W652 itself —
W652.1/.2/.3, all DONE with result shas — so W653 closes as the plan record,
not a re-split. A second split would duplicate landed work.

## Scope A — liveness x4 → one read face (W652.1)

- `packages/suspenders/hooks/lib/lane-liveness.ts:343` `auditLanes`, `:359`
  `verdictBySid` — the canonical liveness read. work lanes is the canonical
  verb face; coord fleet / dispatch registry / monitor delegate.
- Commits: 90a770c7, 16ef25f3 (in main).

## Scope B — coord event reads x6 → subscribe THE face (W652.2)

- One `readEvents`/`advanceCursor` core in `hooks/coord/bus.ts` behind
  poll/wait/inbox. Relationship: subscribe = live WS push (W303), wait =
  long-poll fallback, poll = one-shot manual read, inbox = directed catch-up
  (--ack advances). Cursor advances only past SHOWN.
- Help + README carry the relationship table. Commit: 5f6fae0c (in main).

## Scope C — harvest/usage family audit (W652.3 + W652.3.1)

- One transcript-tail engine: `hooks/lib/harvest-engine.ts`
  (scanTranscriptTails discovery+byte-cursor+tail+line framing,
  sessionActorMap, gatedHarvest); usage-harvest + activity-harvest ride it;
  private readTail/cursor/actor/gate copies retired; byte-true cursors fix
  W243's multibyte under-advance.
- Shared dashboard chrome: one shell/palette/tiles source for both HTML
  emitters (45e4cd69); usage/federation panels onto Lit web components
  (klh-usage-* in board-html/usage-panels.ts, W184 staged track) — dbb33f48.
- Commits: 3c048378, 45e4cd69, dbb33f48 (in main).

## Verification

All six commits are ancestors of main (merge-base --is-ancestor, checked
2026-10-12). auditLanes/verdictBySid present in the worktree at lane-liveness.ts.
