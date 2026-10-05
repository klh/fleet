# Owner-Correction Taxonomy (W438)

Research date: 2026-10-05. Research only — no code changes. Question: can
Klaus's long-history correction patterns be replicated by a mechanical
WISDOM-TIER monitor agent? Answer: partially — roughly seven of the ten
classes below are mechanically detectable with existing surfaces; two or
three need judgment, and a hard core of calls stays owner-only by design.
The recommended shape is a read-only monitor that detects, ranks, and emits
NEED_DECISION with options — never mutates, never executes.

## 1. Method and corpus

Sources mined (all read-only, via work/coord CLIs and repo reads — never raw
sqlite3 on governor.db):

- Work graph: `work list` (187 rows), `work show` on exemplars
  (W137, W144, W182, W183, W190, W202, W209, W264, W287, W290, W304.2,
  W310-315, W367, W385, W422.17, W439, W455).
- Event bus: `coord events --last 11000` — 10,871 real events captured to
  /tmp/w438-events.txt. ~40 NEED_DECISION events, 805 BROADCAST events
  carrying only 48 unique broadcast ids, and the full NEED_DECISION history
  from #521 (10d ago) to #10471 (1h ago).
- Coord facts: `coord fact get <key>` for every lesson._/finding._/advice.*
  key referenced in the event stream (~24 keys). Note: `coord fact list`
  does NOT surface lesson._/finding._ rows even though `fact get` serves
  them (see §6 anomalies).
- Code: `rg -i "owner"` over packages/*.ts — 30+ files carry dated owner-law
  comments; the strongest are quoted below with file:line.
- Package doctrine: root CLAUDE.md, packages/suspenders/CLAUDE.md,
  packages/suspenders/AGENTS.md, toto-gpt.md, docs/*.md decision records.

Every pattern below cites item ids, fact keys, event ids (#N), or
file:line. Where the graph row is terse, the event stream is the narrative
record — the graph stores title+sha, the bus stores the story.

## 2. The correction classes

### C1. Thin / empty missions (stub mint)

The owner's rule: lanes must NOT invent missions. A work item whose mission
is a bare claim line is debris, and dispatching onto it burns lanes.

Evidence:

- W310-W315 minted 2026-10-03 23:22 as placeholder rows (title=id, no
  scope/parent/description, no bus events), six lanes auto-dispatched onto
  them — finding.w310, NEED_DECISION #5090, #5095.
- Recurrence one hour later: the minter emitted ANOTHER bare batch
  (W313-W322) after #5090 flagged the first — #5179. The emitter was still
  running while the correction was being made.
- W318: stub row whose "mission" existed only in a coordinator broadcast's
  positional list; lane closed it DONE with a sha from the wrong repo
  (finding.w318 v2). W310's title is still literally "W310" in the graph.
- W325, W326, W336: further stubs, each verified against the board API
  before release (#5302, #5297, #5410; finding.w325, finding.w326 (4 event
  refs), finding.w336). Cross-project id collisions made each verification
  harder (suspenders W318 vs gaps W318; fleet W137 vs gaps W137).

Mechanically detectable: YES — near-zero false positives. Claim-time brief
lint: title == id (regex), description null, scope null, no bus events for
the id, sibling items in the same mint batch share the defect. Must filter
per-project first (the W137/W318 id-collisions are the FP hazard). Dispatch
already refuses some of this by title keyword (isOwnerGated,
packages/suspenders/scripts/dispatch-next.ts:338) — extend the same seam.

### C2. Claims without evidence (wrong-repo / dangling-sha closure)

The owner's rule: `work done --sha <sha>` must carry a real, verifiable sha
in the right repo; parse-success is not semantics.

Evidence:

- W318 closed DONE @d3ec6bdf — that sha is gaps main, wrong repo; closure
  INVALID, re-mint required (finding.w318 v2 CORRECTION supersedes the fact's
  own earlier misattribution — the correction record itself needed
  correcting).
- W198 result_sha recorded as 85f6c93 (dangling); real head 85f6d93 — off by
  one char; no amend verb exists (#6079).
- W1 (buckle) closed while the owner-sid held the claim — "3 verbs:
  done/start/take all error" (#5029).
- lesson.audit-verify-against-code: ALGORITHMS.md §2.12/§2.34 described a
  seam as unwired after the code landed in a0339ffe (2026-09-13), so W180
  was registered for finished work — docs-as-evidence failed.

Mechanically detectable: YES — evidence gate on work done: sha must resolve
(`git cat-file -e`) IN the item's project repo, be reachable from the lane
branch, and the claim owner must match the closer. Dangling sha = deny with
rev-parse suggestion. The audit-verify case (docs claim vs code truth) needs
judgment; the sha cases do not.

### C3. Unsafe defaults (exposure binds, permissive surfaces)

The owner's rule: closed by default, opt-in exposure. Repeatedly corrected
from open to closed.

Evidence:

- W264 (sha 551280d): board plist was SUSPENDERS_BIND=0.0.0.0 — LAN-exploitable
  RCE chain (#3851 flagged writes LAN-exploitable until this); fix = loopback
  bind + shared hostGuard (Host allowlist + Origin==Host + per-install write
  token), spoof/rebind tests.
- W190: router-shim pin hostname 127.0.0.1 (suspenders + belt configs).
- W290: belt shim exposure — bind loopback by default, LAN = opt-in (the
  Caddy fragments pattern: `--lan` opt-in REQUIRES forward_auth, per W264).
- The public-stack-perimeter lesson is the doctrine summary: "gates =
  guard-rails not boundaries" — loopback binds were defeated by Caddy
  serving *.local; hence hostGuard, not just binds.

Mechanically detectable: YES — default-drift scan: flag any default bind to
0.0.0.0/:: in plists/compose/config, any new externally-listening surface
without an explicit opt-in flag, any write API without a token check. Source
greps are cheap; the subtlety (Caddy in front of loopback) is codified in
the W264 fix itself and can be a lint rule (bind + fronting-fragment pairs).

### C4. Economics: uncapped spend (cost defaults, fan-out budgets)

The owner's rule: expensive things default OFF; fan-outs are budgeted;
evals must have statistical power before they may spend.

Evidence:

- flashx is refused fleet-wide — owner directive "same upstream family
  saturates together, flashx is too expensive", enforced as data absence +
  law rows: packages/suspenders/hooks/lib/board-config.ts:69-80,
  packages/suspenders/hooks/lib/repo-laws.ts:48,153,
  packages/belt/bin/repo-laws.ts:133, packages/buckle/src/policy.ts:16,
  packages/buckle/src/server.ts:139, packages/buckle/src/router.ts:344,
  packages/buckle/src/candidates.ts:12 ("the law enforces itself through
  data absence").
- W137 (knowledge performance aids, belt-callable context preseeding): the
  knowledge-arch decision (W118-21 → W142) landed the owner's economics:
  verified-only preseed + METERED aids — nothing pre-seeds or pre-calls
  belt for free. (Inference: the item row is terse; the metering is the
  durable outcome.)
- lesson.fanout-rate-budget: 11-lane fan-out killed 3 lanes to LiteLLM 429s
  in ~7 min; one flash-tier key feeds ~6-8 concurrent lanes; fan-out width
  must be capped.
- lesson.eval-power-discipline + finding.w424: model bake-offs need n>=100
  tasks; 33 questions = ±15pt error bars; overlapping intervals = the eval
  abstains. Spend only on powered evals.

Mechanically detectable: PARTIAL. The enumerable spends are lintable
(catalog/ladder rows naming banned tiers, new default-ON knobs that cost
money, fan-out width > cap in dispatch code, eval harnesses without a power
check). "This new feature implies ongoing cloud spend" is a judgment call —
recommend, owner decides.

### C5. Doctrine contradiction (doc vs doc, doc vs code)

The owner's rule: there is ONE truth; stale residue in lane-visible doctrine
is a defect. Corrections here are expensive because they need the owner to
pick which record wins.

Evidence:

- finding.routing-doctrine-conflict: speedy/CLAUDE.md "Hybrid LLM Routing
  Doctrine" says "Default to local" (2026-09-04 residue) while belt docs
  carry the 2026-09-29 owner directive "cloud is fastest, stays default".
  Owner-gated: "merging changes lane-visible doctrine so it waits for the
  owner."
- Event #5148 (b1791064399590): ECOSYSTEM.md corrected fleet-wide — "OWNER
  CORRECTION: buckle is NOT a 2-dialect pass-through — it runs LiteLLM
  internally (W219.1) and reaches 70-100+ upstream providers". A mental-
  model error propagated to five repos before correction.
- W439 (open): root CLAUDE.md names :4000 both "anthropic-shim" and "belt
  gateway" (truth since W304.2); launchd label map undocumented; swarm kit
  path changed W422.4 and docs say only one of the two homes. The item is
  itself a pre-indexed contradiction list.
- packages/suspenders/hooks/gates/governor.ts:74-75: lease expiry was
  reworked after "the www.threads.dk catch-22, owner call 2026-09-25" — an
  idle window pinned every lease it ever took; the correction inverted a
  liveness assumption.

Mechanically detectable: PARTIAL. Same-fact-two-ways detection (two docs
naming one port/one default differently; a doc naming a path that no longer
exists) is lintable. "Which record is stale" is judgment — the monitor
should surface the contradiction with both citations and let the owner pick
the winner, exactly as finding.routing-doctrine-conflict did.

### C6. Duplicate execution (double-spawn, convergent lanes, double landing)

The owner's rule: one lane, one worktree, one writer. Convergence is
reconciled, never raced.

Evidence:

- lesson.duplicate-dispatch-race (30 event refs — the most-repeated lesson):
  fleet-loop re-dispatched sid autow366 3x while the first process lived;
  countermeasure = check laneAlive/sid-liveness before respawn.
- W293: sessions 33c112d7 + glmw293 both live in .worktrees/W293 (#4794).
  W4 (belt): 5 identical claude lanes dispatched into ONE worktree (#4787).
  W287: double-spawn 5 min apart on the same worktree (#4778).
- W258: two writers, one worktree, spike docs citing each other's bases
  (#2015, #2018). W357: two SDK runs, transcript-proven shared 1832-entry
  prefix (#3192, #3199). W249 (#1949), W338 double-landing (#2819), W390
  (#3904).
- Supporting lessons: lesson.duplicate-spawn-lease-check (check worktree +
  claims + peer transcript mtimes before writing), lesson.worktree-convergent-lanes
  (foreign hunks + lease blocks = live co-lane, adopt + reconcile), lesson.occupied-checkout-integration
  (never integrate through an occupied main checkout), lesson.swept-lane-recovery
  (unbootstrapped lanes invisible to the liveness sweep get eaten).

Mechanically detectable: YES — spawn-time census: same-sid live check,
same-worktree writer count, claim-holder vs process owner mismatch. All
three signals already exist (coord fleet, lanes.json, lease hook); the gap
is that dispatch does not consult them atomically.

### C7. Premature / duplicate broadcast (notify-before-verify, emission floods)

The owner's rule: broadcast landed changes — once. A broadcast is a promise
that the change exists.

Evidence:

- The 10,971-event window holds 805 BROADCAST events carrying only 48 unique
  ids. Top id b1790413269603 appears 102x; b1790374198809 85x; b1790353918187
  74x. The ECOSYSTEM.md correction (#5148) flooded 7x; the STACK FAN-OUT
  announcement (#4750s) 25x.
- Docs-only broadcasts exist too (e.g. #10539, #10538) — allowed by the
  standing rule (broadcast landed changes same-turn), so docs-only is not
  the defect; repetition and broadcast-before-evidence are.
- lesson.caveman-insertion-code and the emission-corruption rules
  (content-gate, 2829dca; "prevention over cleanup" owner directive) are the
  same class at the write level: an emission is verified before it is
  propagated.

Mechanically detectable: YES — dedupe by broadcast id (trivial; the flood
is an emitter defect, likely per-subscriber re-emit), plus cross-check that
a "landed" broadcast's work item has a done/landed event with a resolvable
sha before treating it as evidence in briefs.

### C8. Config-in-code violations (config-over-code)

The owner's rule: real hosts/keys/values live only in machine-level runtime
config; repos carry placeholders. And when a directive recurs, it becomes a
mechanism (W236: "mechanize the directive").

Evidence:

- W230: "stack config file: ONE longwinded user-editable config" — the
  stack.yaml as the sole conf; hubctl renders deploys from it.
- Root CLAUDE.md law: "Config-over-code: real hosts, keys, OIDC values live
  ONLY in machine-level runtime config... repos carry placeholders only."
- finding.monorepo-audit (W422.12): the installer contract violations — root
  CI dead (workflows only in packages/*), install.sh never ships blam →
  board import unresolvable in installed prefix. Install-grade law: "manual
  fixes get work-add'd follow-ups... never cp — drift = fork."
- lesson.control-plane-first (owner called it 2026-10-02): NO inline bun -e
  scripts over internal state files; extend the CLI as a registered item
  instead of a one-liner hack. This is config/mechanism-in-code prohibition
  applied to ops behavior.

Mechanically detectable: PARTIAL. Grep-able: hardcoded /Users/kk paths,
absolute hosts, key-material patterns (the W236 data-scrub gate spec lists
the exact patterns and a local mode-600 denylist). "This constant is a
policy that should live in stack.yaml" is judgment; the recurring-offender
list is mechanical.

### C9. Wrong-tier execution (routing, model-id misuse)

The owner's rule: requests go to the tier the policy ladder intends;
model ids are real ids; tier policy is owner-owned config, never code.

Evidence:

- finding.lane-routing-bypass: keyed request with model=glm-5.3-flash went
  straight to api.anthropic.com (single pool_refill origin; zero
  ladder-fallback/cooldown counters) while the committed :8902 group sat
  healthy in upstreams.yaml — the ladder was bypassed structurally.
- lesson.glm-lane-launch: lanes must use the NORMAL alias grammar
  (ANTHROPIC_MODEL=opus + lane-local ANTHROPIC_DEFAULT_OPUS_MODEL remap);
  an invented id string = [claude-code:unrecognized_model] + instant exit.
- W228 (fastest-and-best routing fleet refresh) and W288 (enhance target ->
  belt direct tier by registry alias): tier policy corrections landed as
  registry/routing-policy rows, not code branches — routing-policy.yaml is
  operator-owned ("edit THIS, never code").
- packages/suspenders/hooks/lib/hub-locate.ts:4: hub labels must resolve to
  a REAL url instead of staying a display-only prefix (owner directive) —
  a display-tier lying about reachability.

Mechanically detectable: YES — route_audit mining is already proven (the
finding itself was produced this way): bucket by upstream origin, assert
ladder counters move, flag zero-counter walks, flag unknown model ids at
ingress (they die instantly and visibly). W209 (escalation-gate bypass in
prefer/no-hint dispatch walks) is the dispatch-side sibling, still READY.

### C10. Owner-gating failures (decisions taken without the owner)

The owner's rule: irreversible/outward/rule-changing calls are the owner's.
Lanes surface options; the owner picks. The system already has the seams.

Evidence:

- GO protocol: cut-overs execute only on a recorded owner GO — W202 "EXECUTE
  W144 cut-over (owner GO recorded: finding.w144-cutover)"; W422.1 "MONOREPO
  MIGRATION (owner GO 2026-10-05)"; W422.9 NEED_DECISION #10457 asks the
  owner before `gh repo create` (outward-facing, not lane-callable).
- W385: parked/* retirement — "~85 parked snapshot branches" retired only
  after the owner decides; W412 (FAILED) is the failed auto-integration
  attempt of the same class.
- isOwnerGated() (dispatch-next.ts:338): dispatch refuses titles carrying
  OWNER-GATED/GATED/HELD/NEED_DECISION/DECISION/PAUSED — the gate exists;
  the failures are the gaps around it.
- Negative exemplar: W318's lane closed DONE on a stub with no GO-equivalent
  evidence (C2) — the inverse of the lanes that correctly released empty
  missions and emitted NEED_DECISION (finding.w310 protocol).
- Precedent monitor: 13 events in the window are NEED_DECISIONs "surfaced by
  monitor: the NEED_DECISION for this item was never emitted" (#817, #815,
  #816, #2378, #2002, #1686, #1672, #1455, #1264, #1263, #1262, #2984,
  #4016) — a monitor actor already exists in the gaps project and the
  pattern is accepted practice.

Mechanically detectable: PARTIAL. Keyword gate + "decision attempted without
a NEED_DECISION trail" cross-check is mechanical (the monitor precedent
proves it). "Is THIS decision owner-class?" is judgment — recommend, with
options, and let the owner rule.

## 3. Detectability summary

| Class                            | Verdict                   | Primary detector                                                   |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| C1 thin/empty missions           | Mechanical (near-zero FP) | claim-time brief lint, project-filtered                            |
| C2 claims without evidence       | Mechanical (sha cases)    | evidence gate on work done                                         |
| C3 unsafe defaults               | Mechanical (medium FP)    | bind/exposure default-drift scan                                   |
| C4 economics / uncapped spend    | Partial                   | banned-tier lint + default-ON cost knob lint; new-spend = judgment |
| C5 doctrine contradiction        | Partial (highest FP)      | cross-doc same-fact diff; winner = owner                           |
| C6 duplicate execution           | Mechanical                | spawn-time liveness + worktree census                              |
| C7 premature/duplicate broadcast | Mechanical (near-zero FP) | broadcast-id dedupe + sha-exists cross-check                       |
| C8 config-in-code                | Partial                   | scrub-gate patterns; policy-shape = judgment                       |
| C9 wrong-tier execution          | Mechanical                | route_audit counter mining                                         |
| C10 owner-gating failures        | Partial                   | gated-keyword + missing-NEED_DECISION-trail                        |

Verdict on the mission question: 6 classes mechanical today, 4 partial
(partial = the detection is mechanical, the ruling is not). The
owner-unique remainder is small and sharpenable: choosing between
contradictory records, ruling on new spend classes, GO/NO-GO, publishing.

## 4. WISDOM-TIER monitor agent spec

### 4.1 Positioning

Three enforcement tiers exist; the wisdom tier is the third.

1. Reflex tier — PreToolUse/PostToolUse gates (files.ts, governor.ts,
   content-gate): per-write, synchronous, deny-or-allow.
2. Supervisor tier — scripts/supervise.ts (W146): scoped micro-supervisor
   over one subtree; dispatches, integrates, escalates UP via NEED_DECISION;
   scope-isolated by inScope() on every action.
3. Wisdom tier (this spec) — fleet-wide, read-only, cross-cutting correction
   detection over the event bus + graph. It owns NO items, holds NO claims,
   runs NO commands that mutate state.

The wisdom tier watches the watchers: its subject is the correction history
itself (the classes above), its output is decisions surfaced, its only
writes are finding.wisdom.* facts and NEED_DECISION emissions.

### 4.2 Architecture

- Rides the coordination plane: one `coord subscribe --as wisdom` WebSocket
  (WS-first, W303 owner directive — never poll) for event push, plus
  periodic sweeps on the fleet-loop cadence for things events don't carry
  (graph hygiene, doc cross-checks, bind scans).
- Reads: work CLI verbs, coord fleet/events/fact get, board /api/tasks
  (project-filtered), git (read-only), repo files. Never raw sqlite3 on
  governor.db — the CLI/API is the interface (lesson.control-plane-first;
  the fact list/get anomaly in §6 shows why the API layer must be fixed,
  not bypassed).
- Identity: a registered session (coord bootstrap --as wisdom --name
  wisdom-monitor) so coord fleet shows it and the liveness sweep doesn't
  eat its home (lesson.swept-lane-recovery).
- Host placement: same store as the fleet-loop tick (the monitor is a
  sibling consumer, not a new plane). No new ports.

### 4.3 Trigger cadence

- Event-driven (immediate, <5s): work.added (C1 lint), work.claimed (C1 +
  C6 census), spawn/landed events (C6), BROADCAST (C7 dedupe), work.done
  (C2 evidence gate), route_audit tails if belt streams them (C9).
- Periodic sweep, per fleet-loop cycle (~5-15 min): C6 stale-claim vs
  liveness, C9 counter-zero walks over a bounded lookback (mirrors
  quota-sweep.ts's lookback+once-per-24h pattern), C3 default-drift on
  changed files only (diff vs last sweep).
- Slow sweep, daily: C5 cross-doc contradiction pass over CLAUDE.md/
  AGENTS.md/docs (bounded: the ~6 doctrine files the owner names in W439),
  C4 banned-tier + default-ON cost knobs, C8 recurring-offender greps,
  C10 gated-item census (items GATED/HELD with no NEED_DECISION trail).
- Emission budget: per class, one open NEED_DECISION per subject per 24h
  (the quota.exhausted pattern, quota-sweep.ts) — aggregated, not per-event.

### 4.4 Detection rules per class

| Class | Rule (mechanical core)                                                                                                                                         | Judgment remainder                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| C1    | title==id OR (desc null AND scope null AND no bus events for id), project-filtered                                                                             | none — retire/re-mint is the protocol              |
| C2    | done event sha fails `git cat-file -e` in project repo OR sha repo != item repo OR closer != claim owner                                                       | docs-vs-code claims (audit-verify class)           |
| C3    | default bind 0.0.0.0/:: in changed plist/compose/config; new listening surface without opt-in flag; write route without token check                            | none for the core; fronting-pairs lint is additive |
| C4    | ladder/catalog row naming banned tier; new default-ON knob with cost semantics; fan-out width > lesson.fanout-rate-budget cap; eval harness without power gate | new spend classes                                  |
| C5    | same fact asserted differently across doctrine files (port, default, path); doc cites non-existent path/verb                                                   | which record wins                                  |
| C6    | spawn with same-sid live entry; >1 live writer per worktree; claim owner != live process sid                                                                   | adoption vs standdown choice                       |
| C7    | same broadcast id re-emitted; broadcast claims landed without matching work.done/landed event                                                                  | none for dedupe                                    |
| C8    | /Users/kk paths, key-material patterns, real hosts in staged/committed diffs (W236's denylist)                                                                 | policy-shaped constants                            |
| C9    | upstream origin outside the model's committed group; ladder counters zero over lookback; unknown model id at ingress                                           | none for counters                                  |
| C10   | gated-keyword item with lane actions and no NEED_DECISION event on its thread; irreversible verb attempted by non-owner sid                                    | is-this-owner-class                                |

### 4.5 Output contract

- The ONLY actions: (1) `coord emit NEED_DECISION --to <owner sid> --note
"class + evidence (ids/shas/file:line) + 2-3 named options + recommend"`,
  (2) `coord fact set finding.wisdom.<subject> '<evidence pack>'`,
  (3) aggregate broadcast is forbidden — NEED_DECISION is addressed to the
  owner, never fleet-wide; the owner's ruling propagates by the existing
  broadcast protocol.
- Note format (fixed skeleton, machine-checkable): CLASS, EVIDENCE
  (citations only, no narration), OPTIONS (>=2, one recommended), ROLLBACK
  (what un-does each option), DEDUPE (subject key + ttl).
- NEVER: work add/done/take/reclaim, lease ops, dispatch, gate changes,
  settings/env changes, repo writes. Recommends only. If a detection needs
  a new verb, that is itself a NEED_DECISION (lesson.control-plane-first:
  extend the CLI as a registered item).
- The upgrade path: when the owner rules, the ruling graduates — repo-laws
  row, gate rule, or CLI check (the W236 "mechanize the directive" move).
  The monitor's rules table SHOULD be expressed in a data file so a ruling
  can promote a detection rule into a reflex-tier gate without new code.

### 4.6 False-positive bounds

Design targets (no FP history exists yet — these bound the first 30 days):

- C1, C7: near-zero (regex/id equality). Expect the main risk to be missed
  detections (the minter mutated between batches), not false alarms.
- C2: near-zero on sha resolution; the closer-vs-owner check inherits the
  lease-hook identity subtleties (subagent id suffix, governor.ts:56-63) —
  exempt-list handling must match the Bash gate exactly.
- C6: medium — resume-after-crash looks like double-spawn; require
  liveness window (the 15-min lease TTL pattern) + transcript mtime before
  flagging, mirroring lesson.duplicate-dispatch-race's countermeasure.
- C9: low — route_audit rows are objective; lookback windows must exclude
  deliberate override requests (a `--allow` env if one exists) to avoid
  flagging sanctioned walks.
- C3: medium — bind scans hit test fixtures (fixed ports, loopback in
  tests); scan changed files vs main, skip test paths, require the
  production plist/compose surface.
- C4/C8: low-medium — banned-tier and scrub patterns are closed lists;
  FP risk is allowlist drift, so allowlists live in the mode-600 local
  config, never committed.
- C5/C10: unbounded without judgment — these two MUST remain
  recommend-only, and the monitor's credibility budget should be spent
  keeping their emission rate low (max ~1/day/class) so the owner reads
  them.

Global guardrail: if the monitor emitted on everything it can express, the
owner would have received ~40 NEED_DECISIONs in the last 10 days on top of
the ~40 lanes already emitted. The spec's value is the budget: detect
everything, emit the top-N ranked by (evidence strength x blast radius),
suppress by dedupe ttl, park the rest in finding.wisdom.queue for the daily
digest.

## 5. What stays owner-only

Non-negotiable, from the graph and the doctrine files:

- GO/NO-GO on cut-overs, migrations, and publishes (W144 protocol, W202,
  W422.1, W422.9's `gh repo create` question) — outward-facing and
  irreversible.
- Choosing between contradictory records when both are lane-visible
  (finding.routing-doctrine-conflict) — the winner becomes law.
- New spend classes and their defaults (C4) — flashx-style bans are owner
  directives that code then enforces "through data absence" (candidates.ts:12).
- Retiring or rewriting history (W385 parked/* retirement; gitleaks history
  purge options in #4464/#4474/#4508 — "(c) accept and push with manual
  override (owner only)").
- Any owner-GATED/HELD item (isOwnerGated already keeps dispatch off them).
- Promoting a correction into law (which class becomes a gate) — the
  monitor proposes, the owner ratifies. This is the meta-correction and it
  is intentionally not mechanizable: the owner's scarce resource is not
  detection but authority.

## 6. Anomalies and surprises found during this research

- `coord fact list` does not surface lesson._/finding._ rows that
  `coord fact get` serves (667 rows shown, 0 lesson/finding; store API at
  127.0.0.1:7794 per ~/.cache/claude-governor/store.url — its list face
  filters or serves a different view). The knowledge layer's read faces
  already had one outage like this (lesson.knowledge-split-live-outage,
  NEED_DECISION #4585). The wisdom monitor depends on these faces — fix the
  list face before relying on it.
- The WISDOM-TIER pattern already has a working precedent: 13 "surfaced by
  monitor" NEED_DECISIONs in the gaps project, and scripts/supervise.ts's
  escalation discipline ("escalation goes UP, never sideways"). This spec
  formalizes what that monitor already does ad hoc.
- Broadcast flood scale was bigger than expected: 102 re-emissions of one
  id. Whatever re-emits per subscriber/tick is the single cheapest fix in
  this document.
- The correction record itself was corrected: finding.w318 is at v2 and its
  v2 text supersedes v1's misattribution. Versioned facts work — the
  taxonomy's own fact should expect correction too.
- Cross-project id collisions (W137, W318, W325 suspenders-vs-gaps) are not
  edge cases; they are load-bearing hazards for every class above. Any
  monitor rule MUST project-filter before matching (the
  cross-project-id-collision lesson).
- The most-repeated lesson in the stream (lesson.duplicate-dispatch-race,
  30 refs) is a dispatch defect that was re-taught rather than mechanized —
  the exact pattern W236 exists to end. The owner's deepest correction
  pattern is "directive → mechanism"; the monitor is the proposal engine
  for that pipeline.
