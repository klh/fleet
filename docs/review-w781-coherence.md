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

1. **[medium] `createElementNS` escapes the UI-law write gate.**
   `packages/suspenders/hooks/gates/files.ts:77` blocks client-chunk DOM via
   `/document\.createElement\s*\(/` — which does not match
   `createElementNS(`. `packages/suspenders/hooks/board-html/tasks.ts:607-618`
   already uses it in a client chunk (SVG), ungated. Future client-chunk SVG
   code ships with zero gate resistance.
2. **[low-medium] Hardcoded machine host in a served component.**
   `packages/suspenders/hooks/board-html/klh-console-cards.ts:228` bakes
   `<a href="https://bar.local/">` into the footer — one machine's Caddy name
   in code, no config seam (config-over-code law). Contrast `row()` at :235,
   which builds `${r.name}.local` from data.
3. **[low] Legacy W157 client chunks still construct DOM imperatively**
   (36× `document.createElement` in board-html/renders.ts, 8× decisions.ts,
   3× core.ts) despite suspenders/AGENTS.md's W184 "elimination, not
   deprecation" stance. XSS-safe (values via textContent/createTextNode) —
   law-conformance, not injection.
4. **[low] Stale vendored Lit chunks network-reachable.** board-html/vendor/
   holds 5 lit-\*.js files no bundle imports (old 1.2.0/1.3.0 theme builds +
   one byte-identical to the live chunk); the /vendor/ route
   (routes-data.ts:123-141) serves any lit-\*.js in the dir, so dead,
   divergent bundles stay fetchable.
5. **[low] License inventory drift.** license-audit.ts:240-246 lists the
   board's vendored Lit bundles but misses the live `lit-bzn90w03.js`
   (imported by klh-service-row.js + klh-topbar.js) and covers two
   unreferenced ones.
6. **[low] Comment drift on vendor layout.** klh-components.ts:3-5,
   klh-service-row.ts:7-8, usage-panels.ts:10-11 say the build emits "one
   shared lit-shared.js runtime chunk"; the actual output is content-hashed
   `lit-XXXXXXXX.js` chunks.

Verified coherent: innerHTML hits are vendored Lit internals only; both
first-party GUIs textContent-clean; Lit 3.3.3 / LitElement 4.2.2 in both, no
version drift; zero CDN references (offline-LAN law held); loopback port
defaults are all env-overridable fallbacks; every client-chunk fetch target
and belt client fetch resolves to a live server route; klh-theme byte-identical
duplicate is sha-pinned by test; unsafeSVG renders only the fixed first-party
icon set.

### P2P / coord / store

1. **[medium] `work supersede` emits no event — decision auto-cancel is dead
   for superseded tasks.** Producer: `hooks/bin/work.ts:1108-1117` calls
   `setState(id, "SUPERSEDED", ...)` with no `emit()` (contrast `cancel` at
   :1104 → `work.cancelled`). Consumer: `hooks/board/lanes.ts:190-199`
   auto-CANCELs OPEN decisions when events of kind
   `('work.superseded','work.cancelled','work.supersede','work.cancel')`
   exist — three of the four kinds have no producer anywhere. W798 fallback
   (lanes.ts:204-213) covers state DONE only. Net: OPEN NEED_DECISION forks
   linked to a superseded item hang OPEN forever. Verified first-hand by the
   lane.
2. **[medium] Orphan consumer: `conflict` event kind has no producer.**
   `hooks/coord/fleet.ts:537-546` counts `kind = 'conflict'` events for the
   `coord fleet` friction line; zero emit sites exist repo-wide — the line
   always reports 0 (misleading telemetry).
3. **[medium-low] `paused` event targeted at literal `"coordinator"`, not a
   sid.** `hooks/coord/bus.ts:547-558` inserts target `"coordinator"`; the
   store WS filter (store-server.ts:184: `row.target !== f.as`) and
   inbox/readEvents never deliver it to anyone — direct-table readers
   (`coord fleet` dwell) still see it, so the push plane silently drops it.
   Compare `lane.interrupted` (bus.ts:450) and `resume_ready` (bus.ts:597),
   which target the real sid.
4. **[low] Dead kind names in the decision ACK heuristic.**
   hooks/board/lanes.ts:221: of
   `('checkpoint','landed','test_green','interface_changed','NOTE','resume_ready')`,
   only NOTE and resume_ready can realistically fire (plain `landed` is never
   emitted — producers are `work.landed`/`knowledge.landed`; `test_green`/
   `interface_changed` exist only in demo data).
5. **[low] sid resolution asymmetry work vs coord.** `work take/done/... --as`
   expands truncated sids via `resolveSidOf` (lib/govdb-sessions.ts:87-101);
   `coord pause/inbox/subscribe/state --as` take the raw argv token
   (bus.ts:345,393,418,477) — a truncated sid writes a shadow fact
   (`lane.<prefix>.state`) and targets a nonexistent session.
6. **[info] notify local-dev tail misses directed events.**
   hooks/bin/notify.ts:76 filters `target IS NULL` only; the WS path also
   delivers `target = cfg.as` — directed NEED_DECISIONs invisible in
   SQLite mode.
7. **[info] Hardcoded host in prompt template.** hooks/session-start.ts:336
   bakes `https://suspenders.local/#task=...` instead of deriving from
   `SUSPENDERS_ALLOWED_HOSTS`/stack.yaml allowed_hosts. Minor: tracker KINDS
   (tracker/model.ts) omits produced `work.cancelled`/`work.requeued`/
   `work.retried`/`work.lease-extended`.

Verified coherent: store WS read-filter exactly mirrors readEvents
(target/scope/kinds + forward-only cursor); named narration kinds
(work.landed, knowledge.settled) produced; pause/resume protocol chain
produced + consumed; store port map fully config-over-code (env → store.url
file → in-process; 7794/7795/7796 only as env defaults + stack.yaml);
project identity single-source (git-common-dir) incl. W428 rekey; lane
identity canonical-v1 gate enforced; notify KIND_CLASS kinds all produced;
hubctl + coord verb sets match AGENTS.md (documented core subsets).

## Disposition

Findings recorded as `coord finding.w781*` facts (finding.w781,
.w781-supersede-no-event, .w781-gui-gate-escape, .w781-llm-signalling,
.w781-monitor-ghost-check, .w781-coord-event-orphans, .w781-api-doc-drift).
Follow-up work items minted: W879 (supersede emit), W881 (createElementNS
gate), W882 (retire monitor-agent check), W884 (buckle reasoning_effort
clamp), W885 (paused event sid target). Lower-severity items live in the
facts for later triage. No code edits in this lane.
