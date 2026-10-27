# Structural prevention plan — W1302 (2026-10-25)

Turns the deduplicated evidence log (`docs/workflow-adjustments-2026-10-25.md`,
A1–A16 + O1–O4) into code-level structural guards. Every mechanism is classified:

- **(a)** already structurally prevented — the named gate/test enforces it today;
- **(b)** prevention owned by a landed Work Graph item (merged to main);
- **(c)** needs a NEW structural guard — minted as a child of W1302 (§ Children).

Evidence was verified against current main `9cd47f60` on the post-W1276 reorg
tree (§ Reorg-layout check). No working gate was weakened to manufacture a
class; where a landed item leaves only operational verification, that is stated.

## Classification

| ID | Class | Prevention status | Evidence |
| --- | --- | --- | --- |
| A1 · config pointer | (b) | Installer repoints the migrated env pointer atomically, including on later installs; outside-process detection recovers a dead spoke. | W1278.1 merged `f9116d2f`; W1278.2 DONE. Residual fresh-install verification is operational, not structural. |
| A2 · stale operation hold | (c) | Nothing enforces hold provenance or expiry: `mergeHoldActive` is a bare `existsSync` — any `.fleet/merge-hold` defers all merges forever. | `packages/suspenders/hooks/lib/lanes/ladder-lease.ts:73`; consumed at `lib/fleet-loop/merge.ts:111` and `hooks/bin/fleet-loop.ts:301`. → child 1 |
| A3 · dead-lane allocation | (b) | Allocator never *assigns* to a dead lane (recommend only); reclaim refuses unless claimant death is provable, with recycled-pid/transcript identity aging out. | `lib/work/work-alloc.ts:313` (`free = live && load < capacity`); W1072.3 merged `30dcc07a`, contract pinned by `test/reclaim-liveness-contract.test.ts`. |
| A4 · split-child branch identity | (b) | Kept split child binds review to its verified branch commit via canonical child context, not branch-name assumption. | W1279 merged; `lib/lanes/item-branch.ts`; `test/item-branch.test.ts`. |
| A5 · review admission | (b) | Transport failures open a global admission pause; deferred legs reopen with capped jitter; dead-PID legs refund attempts; no unbounded reviewer stampede. | W1280 merged `dc7da924` (via W1293); `lib/gates/review-scheduler.ts:34-50,247,295,364`. |
| A6 · post-close reorg integration | (a)+(c) | SHA-mismatch deferral is structural: a DONE closure only merges when `result_sha` resolves to the exact branch HEAD; unknown/stale fails closed. The dangling-path half (reorg merge deletes paths live code still references) has no scan. | (a) `lib/lanes/ladder-lease.ts:28` (`doneShaResolves`, W1072.2). (c) → child 2 |
| A7 · provider pressure vs gate pacing | (b) | Bounded gap escalation/recovery lands; residual is matched-ramp *measurement*, parked under W1266 (FAILED — requeue via `work retry`). | W1273 merged `72c92a77`; `docs/workflow-adjustments-2026-10-25.md` A7. |
| A8 · unreachable hub hop | (b) | Guarded direct Coding Plan rows replace the Docker→`127.0.0.1:4100` hop; route-preflight delivery drills prove each configured hop reaches a terminal. | W1286 merged `655bf87f`; preflight drills in `deploy/` route checks. |
| A9 · review transport budget | (b) | Long-review hub/spoke timeout defaults persisted in source config so reinstall cannot regress them. | W1288 merged `90b34c9a`. Proving a long exact review terminals through Buckle is operational. |
| A10 · synthetic preflight contradiction | (b) | 429 drill accepts refusal only for the exact pinned Flash alias when cross-model delivery is disproven; unrelated shared-account aliases still fail. | W1287 merged `642188f3`; isolated regression test landed with it. |
| A11 · invalid private hub pin | (c) | `renderEnv` validates ref *shape* (pinned, overlay rules, pin agreement) but never resolves existence — a nonexistent tag renders fine and dies at `fleet-repo` exit 128. | `packages/suspenders/deploy/hubctl.ts:176-205`; no `ls-remote`/ref resolution anywhere in `deploy/`. → child 3 |
| A12 · import-law drift in hub route | (c) | The ratchet exists as a repo-root test but is not wired into the branch done-gate: `work done` runs bench-docs, claim-check and patch-first — no import-law verdict — so drift surfaces only at CI/merge. | `tests/fleet.import-law.guard.test.ts`; gate imports at `lib/work/work-completion-record.ts:4-8`. → child 4 |
| A13 · review receipt base drift | (b) | Receipts survive ordinary disjoint test-source changes and go stale on shared config/setup/build inputs; uncertain Git evidence still fails closed. | W1290.1.1 merged `c0964dd9`; boundary pinned at `test/review-receipt.test.ts:236-281`. |
| A14 · prior review blocker lifecycle | (b) | Prior B-IDs ride into the reviewer prompt; one exact matcher captures and suppresses bullet-form resolutions; a later PASS alone cannot erase an earlier blocker (fail-closed). | W1284.1 merged `a4ef98c4`; W1284.2.1 merged `399a7e54`. |
| A15 · reviewer generation budget | (b) | Flash review legs carry a 16k-token verdict budget with a request-contract test requiring a terminal verdict, not a constant. | W1289.1 via W1293 merged; `test/review-lane-proof.test.ts`. |
| A16 · live-claim stop-gate proof | (b) | Live-claim stop-gate behavior proved by test, not just focused unit results. | W1292.1 merged `c864411b`; residual installed-green confirmation is operational. |
| O1 · zero-snapshot misclassification | (c) | Stall classification reads transcripts/process tables only; a lane with a live in-flight origin request (100s+ streamed) can be misread as idle. No transport cross-check exists. | `lib/fleet-loop/stall-watch.ts`; `lib/lanes/lane-liveness.ts`. → child 5 |
| O2 · stale log errors | (a) | `loop.log` lines are timestamped (the evidence log itself cites merges "at 12:53:36 UTC"), the cycle fence and live-MERGE pid check separate the current cycle from earlier generations; misreading old stacks is operator discipline, not a missing gate. | `hooks/bin/fleet-loop.ts:153-163`; `scripts/lib/controller-fence.ts`. |
| O3 · served wire-model drift | (c) | Receipts *record* `wire_model` but nothing asserts it matches the requested model class — a Flash-requested review served by `gpt-6-sol` lands as a clean PASS receipt. W1285 pins the policy; the receipt stays silent on violation. | `hooks/bin/review-lane.ts:260,305,629` (capture/publish only); `test/review-lane-proof.test.ts:306,465` asserts recorded values, never requested-vs-served. → child 6 |
| O4 · broken-test-import canary | (b)+(c) | Instance repair is owned (route-preflight suite dead: `routeInputsByMachine` no longer exported — reproduced: `0 pass / 1 fail / 1 error`). The *class* — a reorg removing an export silently kills a suite nothing watches — has no canary. | (b) W1294.13 (READY). (c) → child 7 |

## Children (class-c, minted under W1302)

1. **merge-hold provenance+expiry** — `.fleet/merge-hold` must carry
   owner/reason/expiresAt; the controller refuses or ages out holds lacking
   valid metadata and emits NEED_DECISION on expiry instead of deferring
   forever. (A2)
2. **post-merge dangling-path scan** — after each guarded merge, verify no
   live import/config references a path the merge deleted; plus a post-close
   repair-handoff regression (branch advanced past an immutable close). (A6)
3. **hub deploy ref-existence preflight** — resolve the stack `version` and
   overlay `repos.ref` against the origin (`ls-remote`) and check pin agreement
   before activation; fail closed. (A11)
4. **import-law ratchet in the branch done-gate** — `work done` runs the
   cross-package import guard over the branch diff; new relative reach-ins
   refuse closure instead of surfacing at CI/merge. (A12)
5. **transport-aware stall classification** — a stall verdict must cross-check
   Buckle in-flight admin requests before marking a lane stalled/idle. (O1)
6. **served-wire-model assertion** — review receipts assert requested model
   class vs served `wire_model`; mismatch marks the receipt degraded/blocked
   rather than clean PASS. (O3)
7. **test-import resolution canary** — a law-guard parsing test files' relative
   imports and verifying targets + named exports still exist, so a reorg that
   removes an export flips a red guard instead of silently dead suites. (O4)

## Reorg-layout check

All cited paths were resolved on the post-W1276 tree (this branch, `9cd47f60`):
gates live under `packages/suspenders/hooks/lib/gates/` (review-scheduler,
review-receipt), work-graph logic under `lib/work/` (work-alloc,
work-completion-record), lane/lease logic under `lib/lanes/` (ladder-lease,
item-branch, lane-liveness), the loop under `lib/fleet-loop/` + `hooks/bin/fleet-loop.ts`,
deploy under `packages/suspenders/deploy/`, and the law guards at repo-root
`tests/` + `packages/suspenders/test/`. No proposed guard assumes a pre-reorg
path; the one reorg-broken fixture (route-preflight) is row O4 and its repair
is W1294.13, with the class canary as child 7. Children 4 and 7 must target
the post-reorg locations above, not pre-split file roots.
