# Review-leg 502 provenance (2026-11-08, W2859)

Why `claude-sonnet-5` review legs showed `502-then-ok` inside multi-hour
review walls, and what the wall time was actually spent on. Companion to
`hub-canary-2026-10-20.md` (the pinned-cloud relay finding).

## The two trails that prompted the question

From the `work.review` receipts (the authoritative corpus — the lane
stderr log carries only no-verdict trails, so a PASS trail never appears
there):

| item | trail | wall |
| --- | --- | --- |
| W2432 | `glm-5.3-flash#1:timeout → #2:timeout → #3:504 → zai-glm-5.3-flash#1:504 → #2:504 → #3:timeout → claude-sonnet-5#1:502 → claude-sonnet-5#2:ok` | 5955.8s PASS |
| W2657 | `glm-5.3-flash#1:timeout → #2:504 → #3:504 → zai-glm-5.3-flash#1:504 → #2:timeout → #3:timeout → claude-sonnet-5#1:502 → glm-5.3#1:504 → #2:502 → #3:ok` | 6605.6s PASS |

Both reached a verdict. In both, the six legs BEFORE the cloud rung are
local/zai timeouts and 504s — that is where the hours went, not the cloud
rung. W2858 landed the fix for that half (`fastFailTimeouts`: a timeout
already spent its wall budget, so the leg is spent after one attempt
instead of three with backoff).

## 502 is not a cloud-rung phenomenon

502-by-model over the same `work.review` corpus (counts halved — each
trail serializes twice per event):

| model | 502s |
| --- | --- |
| local-coder | 451 |
| glm-5.3-flash | 93 |
| glm-5.3 | 81 |
| glm-4.5-air | 49 |
| glm-5.2 | 4 |
| **claude-sonnet-5** | **5** |

The cloud rung contributes ~0.7% of review 502s and self-heals on retry.
Its leg outcomes at attempt #1 are dominated by `Buckle review scoped key
mint refused` (19) and 503 (20) — neither is a provider fault: 502 is
`UpstreamError → deny(502, "no_route")` (`packages/buckle/src/proxy-execute.ts:167`)
and 503 is `no selection` (:40). Both are emitted by our own gate before
or during candidate selection.

Corroborating evidence that the burst is ours, not the provider's:

- the gateway log carries **zero** cloud-seat traffic — its own failure
  mass is zai 429s (`rate_limit_error 1302`) and local `Metal memory
  limit` 503s;
- the spoke log carries **zero** `502` tokens across its whole retention
  and exactly one cloud-candidate line;
- a live `/v1/messages` ping on the seat (max_tokens 16, through the
  buckle front) answered 200 in 0.8–1.1s, three for three.

## Open law finding still in force

`NEED_DECISION #48672` (unresolved): a pinned ALL-cloud group can never
deliver a hintless request — the escalation gate demands `attempts >= 2`
before any cloud row, unreachable when the group has no local rung. That
is the structural reading of `claude-sonnet-5#1:502 → #2:ok`: the first
attempt is spent satisfying the gate. Until it is ruled, the first cloud
leg of every walk is a guaranteed no-op.

## Proposed routing-policy rows (operator-owned — proposal only)

`~/.claude/local-llm/routing-policy.json` is operator-owned; these rows
are NOT edited by this item. Current `gateway.fallbacks`:

```json
"claude-sonnet-5": ["glm-5.3-flash"],
"claude-opus-5-5": ["glm-5.3"]
```

Both are cross-family rungs. A review served over one banks a PASS whose
receipt is graded DEGRADED and parks the item for
`SUSPENDERS_REVIEW_WIRE_PARK_MS` (W2792.1) — the scheduler's own remedy
text names "drop the cross-family fallback for review legs" as the fix
(`packages/suspenders/hooks/lib/gates/review-scheduler.ts:299`).

1. **Drop the cross-family rungs for review legs** — let a claude-family
   request fail to a claude-family rung (`claude-sonnet-5-5`,
   `claude-haiku-5-5`) or fail loudly, rather than succeed into a
   DEGRADED receipt plus a 1h park.
2. **Give each cloud-only group a cheap same-family rung** so the
   `attempts >= 2` gate is satisfied by a real attempt instead of
   burning the first cloud leg — or rule #48672 so a pin counts as the
   warrant.
3. **Order the ladder cloud-first for review legs specifically**: the
   local/zai rungs are the ones producing the timeout storms and the 502
   mass, and they are ahead of a rung that answers in ~1s.

Rows 1 and 3 are independent of #48672; row 2 is the one the ruling
decides.
