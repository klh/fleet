# Amp (ampcode.com) — mechanism vs claimism

Researched 2026-10-07. Method: live fetch of official pages only
(ampcode.com news / notes / docs / changelog); third-party material treated
as leads. Every row cites its source URL. Epistemic rule per owner: MECHANISM
= what the product demonstrably does per official docs; CLAIM = prose
assertion without evidence. Only mechanisms are actionable.

## Verdict up front

Amp's real, novel surface is small: (1) Handoff — compaction removed, replaced
by a structured synthesis seed into a fresh thread, now agent-initiated;
(2) Oracle — a stateless, separate-model review/escalation tool the main agent
invokes deliberately; (3) thread mechanics: queueing, @thread references,
forking, CLI↔editor continuity. Everything else is standard scaffolding
(Task-tool subagents, AMP.md, MCP) or philosophy.

## 1. Mechanisms worth weighing (evidence-linked)

### M1. Handoff = structured synthesis + fresh thread (effort: S — two deltas only)

- What: when a thread grows long, Amp seeds a NEW thread with a structured
  synthesis — progress summary, files read/created, file paths WITH LINE
  RANGES of interesting snippets, tasks/todos — not a transcript summary.
  Old thread stays referencable. Stated rationale: files on disk are the
  source of truth; "the code is the context."
  Source: https://ampcode.com/news/handoff (Oct 3, 2025)
- Delta 2: the agent itself initiates handoff; triggers = thread-too-long OR
  discrete unit of work complete; the agent continues in the new thread.
  Source: https://ampcode.com/news/ask-to-handoff (Oct 7, 2025)
- Evidence status: mechanism documented officially; NO benchmark published.
- Mapping: we already lifted context-pressure guard + PreCompact capsule —
  do NOT rebuild. The two deltas are new:
  (a) capsule SCHEMA: adopt Amp's checkable fields (files-touched list,
  snippet paths + line ranges, todo list) so a successor lane can
  re-verify each field against the worktree instead of trusting prose;
  (b) completion-triggered rollover in the dispatch loop / overnight bench
  so long tasks chain across fresh contexts without an operator or a
  context-pressure event.
- Alternative not chosen: full compaction-free posture (Amp removed
  compaction entirely) — rejected: our lanes are weaker/local models; the
  in-place capsule is the cheaper safety net.

### M2. Oracle = stateless strong-model escalation tool (effort: S)

- What: a TOOL the main agent invokes; runs on a separate, stronger model;
  stateless (no memory between calls); no automatic routing — the main agent
  decides; used for code review, bug-hunting, hard analysis.
  Sources: https://ampcode.com/news/oracle (Sep 17, 2025);
  https://ampcode.com/docs/subagents
- Model swaps under the role: changelog shows Oracle later moved to
  gpt5.1-codex-max. Source: https://ampcode.com/changelog
- Evidence status: mechanism real (docs + changelog). Usage-pattern claims
  (Oracle as "stuck" signal) are third-party — see C2.
- Mapping: we have :8903 reason tier + task-layer model pinning already. The
  liftable part is the CONTRACT: a named review/escalation tool in every
  lane's toolset with a fixed prompt contract (review this diff / find bugs /
  analyze this), stateless, on a pinned strong route — replaces ad-hoc
  "please review" phrasing.
- Alternative not chosen: automatic stuck-detection routing (route to strong
  model on error thresholds) — rejected for now: anti-thrash lift already
  covers retry pathology; auto-routing adds a failure mode Amp explicitly
  avoids.

### M3. Turn-boundary message queue (effort: M)

- What: messages typed while the agent works are queued and processed when
  the current turn ends. Source: https://ampcode.com/docs/threads
- Mapping: our SendMessage is interrupts-only by design. A per-lane inbox
  drained by the stop-gate would let the board/operator feed a running lane
  at a turn boundary instead of mid-turn — no mid-turn context corruption,
  composes with the stop-gate continuation enforcer we already have.
- Alternative not chosen: interrupt-style injection (reject — that is the
  corruption path the stop-gate exists to prevent).

### M4. Thread references + forking (effort: M, low priority)

- What: @-mention another thread and its content is injected into the current
  thread's context; any thread can be forked from a prior point.
  Sources: https://ampcode.com/docs/threads;
  https://ampcode.com/news (Amp Now Reads Threads, Oct 29, 2025)
- Mapping: paired-lane findings transfer today = SendMessage prose. A
  thread-ID pull (id → transcript tail) would be cheaper for lane→lane
  handover. Overlaps with coord facts + briefs; only worth it if paired-lane
  handover volume grows.

### M5. Cross-surface thread continuity (effort: M–L, skip unless wanted)

- What: CLI and VS Code extension are clients to the same server-side
  threads; a thread continues across surfaces; editor diagnostics flow into
  agent context. Sources: https://ampcode.com/docs/vs-code ;
  https://ampcode.com/docs
- Mapping: human-facing only. Belt board could attach read-only to a lane's
  thread. Low value for a headless fleet.

### M6. Subagents = Task tool (nothing to lift)

- Same design as Claude Code's Task tool: separate context window, own tools,
  results return as tool results, parallelizable, run on the main model by
  default. Source: https://ampcode.com/notes/agents-for-the-agent ;
  https://ampcode.com/docs/subagents
- Verdict: our fan-out is stronger — OS-process lanes with work-graph claims
  and sha evidence vs Amp's in-process children with no ledger.

### M7. Role-stable routing, no model selector (skip — conflicts)

- What: three roles (main / specialist subagents / small system models); the
  "Dial" gives four autonomy modes; users cannot choose models; roles stay
  stable while models swap underneath.
  Sources: https://ampcode.com/docs/models-and-subagents ; podcast
  "Raising an Agent" Ep. 5 ("Full transparency, like we said no model
  selector, right?")
- Verdict: directly conflicts with our operator-owned routing ladder,
  per-lane pins, and bench reproducibility. The one idea we already embody:
  pin models at the task layer, not the UI.

## 2. Marketing vs real

REAL (documented, observable): handoff synthesis + autonomous handoff;
oracle-as-tool + model swap in changelog; thread queueing/references/forking;
cross-surface threads; subagents-as-tools; AMP.md; MCP support.

CLAIMISM (no primary evidence — do not act on):

- C1 "Handoff 4–6x faster, ~30x cheaper than compaction, better quality" —
  exists only in third-party summaries (e.g. rework.com ranking); the
  official post publishes zero numbers.
- C2 "Oracle acts as a stuck signal; 231 subagents at 97.8% success" —
  single third-party listicle (resources.rework.com), no methodology.
- C3 "the only agent that can work across long-running tasks"
  (https://ampcode.com/news/ask-to-handoff) — self-superlative.
- C4 "knowledge flows through your team" (Teams shared threads) —
  unevidenced; Teams is mechanically org billing + SSO + shared thread
  archive (https://ampcode.com/docs/teams).
- C5 "If we don't use and love a feature, we kill it" — real stance with an
  observable consequence (no hooks, no permission surface, no model picker)
  — for us a limitation, not a virtue.

## 3. Worse than ours

- No hook/gate surface: Amp trusts frontier models raw; we run hook gates
  (prevention-over-cleanup) — mandatory for local/weak tiers.
- No work graph: threads are sessions; no claim/take/done --sha evidence
  chain, no project identity, no lane liveness. Amp Teams' shared thread
  archive is well below governor.db + work.
- No user-visible model routing: kills reproducible benches and the
  buckle→litellm→MLX hardware-aware ladder.
- Continuity is cloud-bound: server-side thread storage is the mechanism
  behind handoff/references/continuity; our lanes must survive on-device
  (launchd, local DBs).

## 4. Already lifted — do not re-propose

Stop-gate continuation, keyword fan-out, per-provider concurrency caps,
context-pressure guard + PreCompact capsule, fake-completion scan,
task-layer model pinning, bash-gate hardening, retry anti-thrash.
(M1's capsule-schema delta is the only permitted touch on this list.)

## Sources

Official (fetched 2026-10-07):

- https://ampcode.com/news/oracle
- https://ampcode.com/news/handoff
- https://ampcode.com/news/ask-to-handoff
- https://ampcode.com/notes/agents-for-the-agent
- https://ampcode.com/docs/threads · /docs/subagents · /docs/teams ·
  /docs/vs-code · /docs/models-and-subagents
- https://ampcode.com/changelog
- https://ampcode.com/ ("Amp is now available. Here's how I use it",
  Thorsten Ball, May 15, 2025)
- "Raising an Agent" podcast Ep. 5 (no-model-selector quote)

Third-party (leads only, unverified):

- resources.rework.com "Best AI Coding Agents in 2026" (C1, C2 origin)
- javisreview.com Amp review (opinionated-stance corroboration)
