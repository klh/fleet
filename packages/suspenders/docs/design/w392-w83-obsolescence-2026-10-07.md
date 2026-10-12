# W392 — parked/W83 role-tier routing obsolescence check (2026-10-07)

Mission (from the item): integrate parked/W83 role-tier routing (`--tier` +
fleet-loop batching + 183 test lines, DONE `e249c6e`) — FIRST check
obsolescence: routing moved belt-ward, owner may rule it obsolete.

**Verdict: obsolete in substance — every capability has a stronger current
equivalent landed after W83 was parked. Integration is not recommended; the
call is the owner's (NEED_DECISION #24866: A close obsolete — recommended /
B re-implement on fleet / C `--tier` as semantic tag only).**

Evidence — W83 (`e249c6e`, old suspenders repo, 2026-09-30) vs fleet
2026-10-07:

| W83 capability | Current fleet equivalent |
| --- | --- |
| `work_items.tier` (mechanical/flagship) → model at dispatch | `modelOf`/`.prefer` chains in `scripts/dispatch-next.ts:213-300` — a model name IS an executor; `glm-5.3-flash` is the default lane model (`:956`, `:1048`); owner routing doctrine (2026-09-30) collapsed the cost axis — flash serves general/fast/draft/reasoning/code |
| `--model`/`-m` pin per lane | `--fallback-model` chains (confirmed 2026-10-03 to recover even flat 400s) + belt routes by model id at request time — `routing-policy.yaml` ladders are operator-owned |
| board tier → belt route role | executor dropdown on cards incl. `llm:*` starts |
| `fleet-loop batch` sequential tier drain | W503 posture `steady\|plaid` target caps + W500 OOM concurrency caps + `lesson.fanout-rate-budget` (≤6 concurrent flash lanes) |

Port cost is not mechanical: at W83's base `hooks/bin/fleet-loop.ts` was 839
lines; the fleet file is 1335 with paths moved under `packages/suspenders/`,
the W296 agent roster, W494 liveness and W503 posture reworked in — a
re-implementation, not a cherry-pick.

Facts: `coord fact get finding.w392-obsolescence` · decision pends on
NEED_DECISION #24866. If the owner rules B/C, re-mint a port item — context
lives in the fact and this record.
