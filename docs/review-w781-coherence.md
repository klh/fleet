# W781 — full-stack coherence sweep (2026-10-19)

Read-only review lane. Evidence-first: every finding below was verified by
reading both sides of the seam (producer + consumer, code + doc, or two
implementation layers). Findings are recorded as `coord finding.w781-*` facts
and minted as work-graph follow-ups; no code edits were made by this lane.

Sweeps: GUI layer, API surfaces, P2P/coord/store, LLM signalling — each run by
a dedicated read-only review agent, headline findings re-verified by the lane.

## Finetuning

Honest statement: the stack has **no active finetuning**, but finetuning
**tooling exists** — `packages/belt/bin/distill.ts` distills with-context
answer packets into LoRA adapters via `mlx_lm.lora` (adapters/ + train.log
under DISTILL_HOME). No adapter is mounted anywhere in the serving path
(`registry.ts` / `router-shim.ts` reference no adapter paths), so nothing
finetuned is in production.

## Findings

### LLM signalling

1. **[low-medium] reasoning_effort diverges between belt (clamp) and buckle
   (verbatim forward).** `packages/belt/bin/escalate.ts:25-30` clamps to the
   Z.AI-verified set (medium→low; comment: "medium is not in the 5.3 set",
   disable/medium 400). `packages/buckle/src/adapters/tools.ts:87,119-122`
   forwards `medium|xhigh|max` verbatim on translated hops. A client sending
   `reasoning_effort: "medium"` through buckle's native translation tier to a
   zai row gets the exact value belt's own comment says Z.AI 400s. Two layers,
   two contracts for the same field.
2. **[low] Stale coherence claim in buckle policy header.**
   `packages/buckle/src/policy.ts:1-2` claims routing-policy.yaml is
   "identical data to belt's" — the two files diverge materially (different
   ladders for glm-5.3-flash; belt carries W648 classes/reasoning blocks,
   buckle carries W142 aids). Divergence itself is intentional (different
   routing planes); the comment is drift.

Verified coherent: retry cap W695.6.1 landed and sane (policy.ts:133 default
`retry_after_cap_s: 60`, clamped in cooldown.ts:16-33, exhausted 429 still
relays provider retry-after verbatim, router.ts:522-527); alias tables
consistent incl. claude-sonnet-5→claude-sonnet-5.5 dots-to-dashes; no active
reference to the retired :4102 ikea-shim; port map (:4000/:4100/:4101/:890x)
matches AGENTS.md; escalation env names (BELT_ESCALATE_\*, ORACLE_ROUTE_\*)
match docs on both legs.

### API surfaces

1. **[medium] Setup check `monitor-agent` demands a launchd label the stack
   now boots out.** `packages/suspenders/hooks/board/data.ts:449` checks for
   `~/Library/LaunchAgents/com.suspenders.fleet-monitor.plist` and FAILs the
   check (fix advice `./install.sh --with-launchd`); install.sh contains zero
   `fleet-monitor` references, and `deploy/services.yaml:292` lists the label
   under `legacyLabels` (boot-out + plist removal). Root AGENTS.md (W779):
   fleet-monitor is NOT a launchd unit — it is a typed fleet-loop task. Net:
   on a correctly-installed machine the setup checklist paints a permanent
   FAIL. `packages/suspenders/docs/board-api.md:110` documents the broken
   check as expected behavior.
2. **[low] Three inconsistent inventories of `GET /api/setup`.**
   board-api.md:100-112 documents 6 checks; `setupChecks()` (data.ts:492-558)
   emits 9 (adds activation, board-unit, hubs); llms.txt (routes-meta.ts:26)
   lists a third variant omitting session-start and monitor-agent.
3. **[low] llms.txt behind the actual route surface.** Existing routes absent
   from the agent-facing contract (routes-meta.ts:7-81): /usage family,
   /api/lane-model/\*, /api/console/network + /audit, /console/hub +
   /api/hub/\*, /api/observation-plane/\*, /api/lane-routes,
   /api/lane-observations, /api/federation-work, /api/recovery,
   /api/orchestrate/targets, /api/decisions/<id>/evals,
   GET /console/settings/<feature>. Several are consumed by first-party UI.
4. **[low] Doc lag on response shapes** (supersets only): /api/tail missing
   `?project` + 409 + DONE `completion` field; /api/console/me adds
   `executor_prefs` vs llms.txt:36.
5. **[low] Existing-but-undocumented CLI verbs.** oracle `panel`; work
   (mine/owned/stats/release/start/summary/fail/retry/cancel/supersede/
   block/unblock/orphaned/extend/migrate-ledger); coord ~30 verbs beyond
   AGENTS.md's list. All documented verbs exist — the docs present subsets as
   the full verb set.

Verified coherent: every llms.txt-documented endpoint exists with matching
method/path; /api/events + /api/activity semantics match docs; task shape
producer == consumer; file-attachment multipart + capability-URL semantics
match; write-perimeter header/cookie match docs; enterprise seam honest 501;
all ~40 frontend fetch targets resolve to live server routes; ports are
env-overridable defaults, no hardcoded machine hosts.

### GUI layer

_(sweep in progress — appended on completion)_

### P2P / coord / store

_(sweep in progress — appended on completion)_

## Disposition

Findings recorded as `coord finding.w781-*` facts. Follow-up work items are
minted via `work add` (see facts for ids). No code edits in this lane.
