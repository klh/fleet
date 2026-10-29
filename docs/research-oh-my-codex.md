# oh-my-codex — research + adversarial audit (2026-10-07)

Repo: https://github.com/Yeachan-Heo/oh-my-codex (TS `src/` + Rust `crates/`). Docs read from
`docs/` on main; every big claim spot-checked against the named source file. Owner rule applied:
"it might just be llm shit thought without thought" — verdicts below are per-doc, evidence-cited,
UNVERIFIED marked where I did not reach code.

Headline: **this is NOT vaporware.** The three reference docs match the code with unusual
fidelity — the docs even warn against inventing config keys. But "Ralph parity" is much smaller
than it sounds (see 3), and the rebalance doc undersells shipped code (see 2).

---

## 1. `docs/reference/omx-config-schema-routing.md` — MECHANISM, verified

`.omx-config.json` (user scope `${CODEX_HOME:-~/.codex}`, project scope `./.codex/`) with
top-level keys: `env` (fallback env, shell wins), `models` (per-mode overrides),
`agentReasoning` (per-agent `low|medium|high|xhigh`), `notifications`, `promptRouting`,
`autoNudge`, `wiki`. Verified against `src/config/models.ts` and `src/team/model-contract.ts`:

- Main default: shell `OMX_DEFAULT_FRONTIER_MODEL` > config `env` > codex `config.toml` root
  `model` > builtin (`getMainDefaultModel`).
- Mode: `models[mode]` > `models.default` > main (`getModelForMode`).
- Standard lane: `OMX_DEFAULT_STANDARD_MODEL` > main — **standard agents inherit the frontier
  model by default**; the cheap lane is the opt-in (`getStandardDefaultModel`).
- Spark lane: `OMX_DEFAULT_SPARK_MODEL` > legacy `OMX_SPARK_MODEL` > config env >
  `models.team_low_complexity` (3 alias spellings tolerated) > builtin (`getSparkDefaultModel` /
  `getTeamLowComplexityModel` — the doc even documents that the two call paths order the alias
  vs spark fallback differently; true in code).
- Role routing (`resolveAgentDefaultModel` in model-contract.ts): role names ending `-low` →
  spark; `executor` special-cased to main; else agent `modelClass` (`fast`/`frontier`/`standard`)
  picks the lane. Reasoning: `agentReasoning[role]` > built-in role `reasoningEffort`.
- Team worker launch precedence: explicit `OMX_TEAM_WORKER_LAUNCH_ARGS` `--model`/`-c
model_reasoning_effort=` > inherited leader launch args > role-class fallback
  (`resolveTeamWorkerLaunchArgs`).

Doc quality: explicitly anti-hallucination ("Do not invent per-role maps such as
`models.executor`"; malformed shapes fail closed). Zero marketing. **Real.**

## 2. `docs/reference/team-allocation-rebalance-policy.md` — MECHANISM, verified (doc undersells)

Design-note style record of the team-mode allocation/rebalance seam. Code exceeds the doc:

- **Startup allocation** — `src/team/allocation-policy.ts` `allocateTasksToWorkers()`: greedy
  per-task scoring over workers. `+18` keep same-role work grouped, `+12` worker-role match,
  `+9` fresh worker of the right role; scope-hint overlap (file paths + domain words extracted
  from task text) `×4` with path hints weighted `×3` inside that, `−3` if the worker owns scope
  but zero overlap; `−4` per already-assigned task (load); extra `−1`/assignment for
  `blocked_by` work (lighter-lane bias). Uniform-role pools cancel role scoring. Deterministic
  tiebreak: score > overlap > load > insertion index. Every assignment carries an
  `allocation_reason` string (stripped from public CLI output).
- **Runtime rebalance** — `src/team/rebalance-policy.ts` `buildRebalanceDecisions()` (the doc
  calls this a "recommended seam"; the module + `__tests__/rebalance-policy.test.ts` already
  exist). Pure decision function: available = `alive && (idle|done|unknown)`; candidates =
  pending ∧ unowned ∧ deps-complete; **reclaimed tasks sort first**, then FIFO by id; emits
  decision objects `{type: assign|recommend, taskId, workerName, reason}`. It never mutates —
  `assignTask()` stays the sole dispatch gateway.
- **Claim safety** — `src/team/state/tasks.ts` verified: claims under `withTaskClaimLock` with
  readiness re-checked after the lock; 15-min lease (`leased_until`); completion/failure
  transitions require the **claim token** and unexpired lease; `reclaimExpiredTaskClaim()` →
  pending. Bonus (not in the doc): terminal `completed` transitions can be **rejected** for
  missing evidence — `missing_delegation_compliance_evidence` /
  `missing_coordination_compliance_evidence` — via regex checks on the worker's own terminal
  result ("Subagent spawn evidence:", "Coordination protocol:").
- UNVERIFIED-in-detail: the doc's monitorTeam line cites (`src/team/runtime.ts:1212-1420`,
  reassign-from-dead/remind/evidence-gap/reclaim recommendations). I verified the cited
  functions it feeds but not all 1400 lines of runtime.ts. Every other citation in this doc
  checked out exactly, so risk here is low.

## 3. `docs/reference/ralph-parity-matrix.md` — real, but self-parity

The matrix tracks 8 rules (iteration persistence, phase normalization, terminal completion,
cancel propagation, session-scope authority, legacy migration, release gate, tier text
out-of-scope) with statuses adopted/adapted/out-of-scope. Adversarial finding: the "upstream"
in `docs/reference/ralph-upstream-baseline.md` is **this same repo's own earlier
`skills/ralph/SKILL.md`**, pinned to commit `165c3688…` with SHA256. So "Ralph parity" is an
internal regression contract (OMX-now vs OMX-then), not parity with an external Ralph
technique. Spot-checks:

- R6 VERIFIED: `src/ralph/persistence.ts` — one-way migration of legacy `.omx/prd.json` /
  `.omx/progress.txt` into canonical `.omx/plans/prd-*.md` + `ralph-progress.json` ledger, with
  SHA256 source markers and a "one-release-cycle" compatibility window. Exactly as claimed.
- R7 VERIFIED by tree: `src/verification/__tests__/ralph-persistence-gate.test.ts` exists
  alongside the QA doc.
- R1/R2/R5 corroborated via zread's indexed excerpts (`state_write`, `validateAndNormalizeRalphState()`,
  session-scope > root precedence, integer validation on `iteration`/`max_iterations`) — files
  exist and match the described shape; not read in full. No contradictions found.

Verdict: honest engineering, tiny scope. "Ralph" here = Stop-hook continuation loop + state
files — mechanism class already covered by our W502. Parity marketing oversells; the matrix
itself does not lie.

## Not lifted

Notifications/OpenClaw/wiki/sparkshell/discord plumbing (no fleet relevance); the
"Team Big Five + ATEM" coordination protocol (prompt ritual, not mechanism);
`crates/omx-runtime-core` `AuthorityLease`/`DispatchLog` (their Rust rewrite of our
dispatch-lock; nothing conceptually new).

---

## Lift candidates for klh/fleet

None of these re-propose W502/503/504/510/511/512/513.

| #   | Candidate                                                                                                                                                                                              | Source mechanism                           | Maps to                                                                                                                  | Effort |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | **Role-class routing schema**: declarative three-lane model (frontier / standard / spark) with inherit-by-default standard lane, read by dispatch + Task pinning instead of hardcoded provider ladders | §1 `models.ts` lanes + `modelClass`        | `~/.claude/local-llm/routing-policy.yaml` (operator-owned) gains class→model rows; buckle/litellm resolve class→provider | S–M    |
| 2   | **`-low` name-suffix tiering**: any role/lane named `*-low` auto-routes to the cheap lane, no registry edit                                                                                            | §1 `resolveAgentDefaultModel` suffix check | dispatch brief composition + W512 Task pinning                                                                           | S      |
| 3   | **Reasoning-effort as a routing axis** separate from model (per-role override map, low…xhigh)                                                                                                          | §1 `agentReasoning`                        | buckle pass-through of `reasoning.effort` (z.ai + MLX both vary effort); composes with W512 model pins                   | S      |
| 4   | **`allocation_reason` + scope-hint affinity**: scorer prefers the lane that already touched overlapping paths/domains; every claim records why it went there                                           | §2 `allocation-policy.ts` scoring          | `work split`/`work take` + govdb row field                                                                               | M      |
| 5   | **Reclaimed-first pickup**: items returned by `work reclaim` sort ahead of fresh READY in dispatch pickup                                                                                              | §2 rebalance sort                          | dispatch brief composition after `work reclaim all`                                                                      | S      |
| 6   | **Claim-token-gated completion**: `work done` requires the token minted at `work take`; stale writers fail                                                                                             | §2 `transitionTaskStatus` token check      | coord tx on `work done --sha`                                                                                            | M      |
| 7   | **Evidence-gated completion (structural)**: the completion tx itself rejects when required evidence patterns are absent from the terminal result — gate vs W511's post-hoc scan                        | §2 `missing_*_compliance_evidence`         | `work done` validation layer (distinct from W511: rejects transition instead of flagging after)                          | M      |
| 8   | **Decision-object rebalance**: coordinator computes `{assign, recommend, requeue}` decisions as data; the claim path stays the only mutator                                                            | §2 `buildRebalanceDecisions`               | dispatch/wired-budget gate output shape                                                                                  | S–M    |

Best value for us: 4 + 5 (lane allocation intelligence we simply lack — we have fixed TARGET +
reclaim only), then 1 (declarative class lanes). 6/7 harden the work graph's trust model the
way the OMX team did.
