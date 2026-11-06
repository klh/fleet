# W2754 — completion-throughput audit: review invalidation vs landing rate, gate retry amplification, per-account budget

Scope: the review pipeline
(`hooks/lib/fleet-loop/merge.ts` → verifyReview → `checkReviewReceipt`
→ `scheduleReview` → detached `hooks/bin/review-lane.ts` → `work.review`
receipts) as it behaves on the live machine (2026-11-04 → 2026-11-06
window). Deliverable per brief: systemic audit + targeted fix of gate
retry/invalidation/account budget; review NOT disabled; gate stays
fail-closed.

## 1. Evidence base

All counters from governor.db events/facts (read via bun -e SQL probes;
no LLM outputs trusted as facts):

- 14-day reviews-vs-landings: ~8–148 review legs per landing on the
  integration lineage; 500-receipt bucket: 44% ERROR — 144
  transport-503 class, 57 no-verdict/16k-length class, 20
  deterministic-proof class.
- 7-day window: 102 stale-base mentions in review events; 49 legs stuck
  RUNNING (crashed runners with live leases).
- W2731 specimen timeline: the same commit+base re-driven twice in 10
  minutes (#112321 → #112393), each a full model leg on the shared
  account.
- W2731 effect-reuse probe (`unchangedReviewedEffect`): the receipt
  base 73a7622 vs integration base 942d416 fails the ancestry precheck
  (`ancestor: false` — the integration lineage rewrites via rebase
  lanes), the preview trees differ (candidate merges absorb newer main),
  and the slow-path vetoes (shared-input veto on the advance, instruction
  digest drift) reject too. Every guard rejects: proof can never ride a
  stale base row on this lineage — by design, not by accident.
- Installed `review-receipt.ts` verified BYTE-IDENTICAL to the repo copy
  (sha 86d781dc…, 482 lines) and carries `unchangedReviewedEffect` —
  the fleet-loop runs what the repo ships; the DONE-definition bullet is
  satisfied: the reuse path exists in the INSTALLED copy; proof still
  rejects stale-base rows because every one of its four guards
  (ancestry, preview-tree equality, shared-input veto, instruction
  digest) is false on a rewritten lineage — weakening it was explicitly
  out of scope (fail-closed law).
- Per-account budget reality (machine conf routing-policy.json,
  zai-coding-account pool): concurrency 8, intervalCap 50/min. Review
  keys ride `trafficClassOf` (lanes.key_name_pattern default
  `^(auto|review|ramp)`) → lane class → buckle admission priority 0,
  AHEAD of interactive lanes (W2617) — reviews out-queue the lanes they
  review, so unbounded review starts directly starve implementation.
- Structured findings convergence (exists, none replaced): W1236.1
  findings accumulation + priorBlockingReviewLines, W1243.1.1 refund
  contract, W1303.7 round cap (FAIL rounds only), W2548 transport park
  (6 deferrals), W2181 fail-closed proof fingerprint.

## 2. The amplification loop (root cause)

A deterministic-proof failure (PASS content + proof `error`/`unknown`
per W2181) grades the verdict ERROR (fail-closed, correct). But the
finish path treats it as transport-class: attempt refund + deferral +
`applyPressure` + backoff → the scheduler re-admits the identical
request → a full model leg → the identical deterministic failure. The
loop only stops at the W2548 transport park after SIX wasted model legs.
W2731's double re-drive (§1) is that loop observed live.

## 3. The fix — three admission rungs + a finish re-classification

All knobs conf-over-env-over-default (W2351 pattern; registry rows in
packages/settings), each 0-disables:

| Knob | Default | What it bounds |
| --- | --- | --- |
| `SUSPENDERS_REVIEW_PROOF_PARK_MS` | 6h | a deterministic-proof finish stamps `proof_park_at`; admission refuses re-drive while fresh; one NEED_DECISION per stamp tells the completion author the leg re-drives when the window lapses or the proof environment is repaired. The finish does NOT open the AIMD pressure pause — a local proof blocker is not provider failure. |
| `SUSPENDERS_REVIEW_BASE_SETTLE_MS` | 10m | a base move defers the first re-review knock until the newest out-of-base receipt + window — landing waves coalesce into ONE re-review per window instead of one per ladder pass. Same-base receipt or unreadable history → fail-open (W1243 law). |
| `SUSPENDERS_REVIEW_RATE_BUDGET` | 30/min | per-minute review START budget on the shared account (scheduler admission), protecting implementation lanes from review-class churn (28 sessions/15m observed 2026-11-04). |

Plus the finish-side re-classification in `review-lane.ts`: a PASS
content verdict whose proof failed deterministically finishes with the
marker-prefixed reason (`coverage-proof deterministic failure: …`);
`finishReviewRequest` stamps `proof_park_at` only on that marker and
gates `applyPressure` on it.

Deliberately NOT touched (fail-closed law): the ancestry/preview/shared-input/digest
guards in `checkReviewReceipt` — proof reuse is already correct-by-design
and W2731's proof outcome is a coverage-proof fingerprint issue owned by
the design-acceptance lane, not a scheduler defect.

## 4. Verification

- packages/suspenders/test/review-scheduler.test.ts: 6 new tests
  (classifier, knobs incl. conf-wins, proof-park refuse/lapse/dedupe,
  transport-finish non-stamp + AIMD non-open, settle defer/lapse/not-a-base-move,
  rate-budget cap/lapse) — 25 pass / 0 fail.
- Neighbors green: review-scheduler-detached (3), review-conf-seam +
  stack-schema + stack-config-sections (29 pass; the one combined-run
  failure re-passes in isolation — known combined-run interference).
- knob-registry guard: my three rows pass; the suite's one red
  (`SUSPENDERS_RISK_TIERS` undeclared, readers in fleet-loop/merge.ts)
  is PRE-EXISTING at HEAD — readers and missing row both predate this
  branch (readers untouched by this diff), out of lane scope.
- Activation: fleet-loop runs the INSTALLED harness copy — the rungs go
  live at next install (memory: done runs installed harness).

## 5. Residual risks / open items

- The proof-park TTL default (6h) parks a lane's review for the window;
  the NEED_DECISION surfaces it to the owner/coordinator. Repair of the
  proof environment (fingerprint mutation) lifts the park only via
  explicit release or TTL lapse — operator-visible, not silent.
- The rate budget counts admissions via the request facts'
  `admitted_at`; the settle/park/pressure fact rows carry no
  `admitted_at` and never count. Backwards-compatible (old request rows
  without the field count 0).
- `SUSPENDERS_RISK_TIERS` knob-row gap (pre-existing) needs its own
  item; flagging it here as the only guard red.
