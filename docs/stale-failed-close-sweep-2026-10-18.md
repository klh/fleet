# Stale-FAILED close sweep — W805 (2026-10-18)

Four stale-FAILED work-graph items resolved with landed evidence. No rework
was performed; every close cites work that is already in main history or a
supersession on the graph.

| Item    | Resolution        | Evidence                                                                              |
| ------- | ----------------- | ------------------------------------------------------------------------------------- |
| W369    | DONE @224eec38    | orchestrate preview landed via W270: `routes-orch.ts:57` POST /api/orchestrate/preview, `board-html/klh-prompt-preview.ts` (323-line component), `vendor/klh-components.js` built (+136) |
| W722    | DONE @f6ba0957    | dispatch intent verb landed: `dispatch-next.ts:177-178` usage, wiring at `:284-286` into `lib/launch-intent-cli.ts` (inspect/fail, liveness-guarded) |
| W279.1  | SUPERSEDED by W279 | W279 landed aa51eede; W725 closed as duplicate with the e-label suites green at HEAD (w279 17/17, 9 router suites 111/111) — `docs/decision-w725-w279-remint-duplicate.md` |
| W454    | CANCELLED (split-close) | claude harness leg landed via W768 (a81cdf50, starter forks default-on + gate-side cache_control); remainder re-minted READY as W808 per coordinator ruling advice.25427 |

## W454 split

W454 scoped starter-session forks across every harness. Only the claude leg
landed (W768); the codex/copilot/gemini/grok legs and the Phase 1 PRE /
Phase 3 POST orientation-cost benchmarks never executed. The FAILED state was
a stale misfire artifact, not work loss. The remainder lives on as W808
(READY) so the graph stays truthful: W454 is closed without claiming
completion of the unexecuted legs.

## Close mechanics note

`work done` refuses FAILED items and its W643 fence requires a lane context
bound to the completing item. The sweep used the state-machine path:
`work retry` (FAILED → READY, stale claim released) then re-`take` then
`work done --sha <landed-evidence-sha> --summary`. For sibling items closed
from a dispatched lane, the per-item fallback channel
(`.worktrees/<item>/.fleet/lane-context.json`, read when the cwd repo top has
no primary context) carries the real claim token from the fresh take; the
spent context files were removed after the immutable completion records were
persisted.
