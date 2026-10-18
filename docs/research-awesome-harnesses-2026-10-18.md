# Awesome agent harnesses — landscape review

2026-10-18 · W794 · lane autow794. Companion to harness-lift-research.md
(2026-10-10, source-level lifts from hermes/gas-city/beads/pi-mono/agent-mail),
research-oh-my-claudecode.md, swarm-comms-research.md (W436),
grid-coordination-research.md (W437). This doc reviews the LIST LANDSCAPE
and names only delta — mechanisms the prior docs did not already cover.

## Sources

| List | Status (verified 2026-10-18 via GitHub API) |
| --- | --- |
| Picrew/awesome-agent-harness | 1,864★ · 375 entries, 9 categories · last push 2026-10-07, README "last verified 2026-10-08" — the living, implementation-first list |
| AutoJunjie/awesome-agent-harness | 530★ · awesome.re-badged, best taxonomy + reading list · last push 2026-04-19 — STALE as a feed, still the best curated reference |
| skillsllm best-of-Agent-Harnesses | 167 harnesses, rescored weekly — ranking surface, not a source of mechanisms |

Star counts below are GitHub-API-verified 2026-10-18 unless marked (list).
Everything else is lead-grade per journalism law.

## Read against our harness, by axis

- **Session continuation.** They: claude-mem (101k★, Apache-2.0, pushed
  2026-10-18) captures session history, AI-compresses, reinjects into
  future sessions; hankweave runs headless long-horizon with event
  journals + checkpoints + sentinels; Herdr gives reconnectable terminal
  sessions with blocked/idle detection; Anthropic Managed Agents decouples
  brain/hands/session (session = event log). We: hand-banked capsules
  (≤10 lines) + RESUME PATH + compaction banking discipline. The capture
  face is manual; resume fidelity is bounded by what the lane remembered
  to write down.
- **Multi-agent fan-out.** They: kanban orchestrators (Vibe Kanban,
  Emdash, Claude Squad), "cheap executor + expensive advisor" (Anthropic),
  team modes (OMC ultrapilot — already researched). We: work graph CAS
  claims, work split, paired lanes, per-item worktrees. We are at or above
  list parity here; prior-art lifts 1–3 own the remaining gaps.
- **Verification gates.** They: Chorus "proof of work + human approval
  gates", Sponsio deterministic per-action contracts, auto-harness
  benchmark-gated overnight loops, hankweave sentinels. We: content gate,
  scrub gate, qlty, verdict contract, work done --sha. Strong, but static —
  no standing loop that mines fleet failures and re-proves the harness.
- **Memory.** They: the hottest category in both lists (claude-mem,
  Graphify knowledge graphs, Zylos tiered memory, Hindsight execution
  history, cq shared commons). We: coord facts + capsules + MEMORY.md +
  knowledge enqueue — durable but coarse; read face measured at zero hits
  since W166 (known outage).
- **Pricing.** They: CodeBurn per-task token analytics, Paperclip budget
  tracking, cascadeflow per-step budget gates, Axon "PR + cost in USD",
  LiteLLM gateway cost tracking. We: buckle per-lane keys + capsule spend
  fields (sit at 0 in practice), quota walls surface as 429s (retry-after
  cap = W695.6.1, pending). No per-item cost rollup, no budget ceiling.

## Top 5 lift-worthy (delta over harness-lift-research.md)

1. **Auto session-journal + compressed resume injection** (memory /
   continuation). Gate-side journal: Stop/SessionEnd gate appends
   structured events (claims, gate verdicts, shas, consults, errors) to a
   per-sid journal; session-end settle compresses the journal into the
   capsule; RESUME CONTEXT injects the last N events. Evidence: claude-mem
   proves demand at 101k★; hankweave ships it headless-first; Managed
   Agents names the session-as-event-log a core primitive. Fits W159
   settle + the existing stop-gate. Compaction-loss and capsule-skipping
   lanes are the incident class this closes.
2. **Per-item cost attribution + budget gates** (pricing). Roll buckle
   ledger usage per lane key → work item on close; board shows cost/item;
   per-item and per-day ceilings from stack.yaml (config-over-code);
   ceiling breach blocks new spawns + NEED_DECISION. Evidence: CodeBurn,
   Axon, cascadeflow all ship the pattern; our per-lane `bksk_` keys make
   attribution near-free — verify the ledger carries per-request token
   rows first; if not, add token accounting at the proxy (buckle sees
   every request; LiteLLM is the reference). Pairs with W695.6.1: quota
   walls become visible as spend curves, not just 429s.
3. **Skill/harness supply-chain scan as an enforced gate** (governance).
   Snyk Agent Scan inventories harnesses/MCP/skills and checks prompt
   injection, tool poisoning, malware; NVIDIA SkillSpector does static
   analysis + risk scoring with CI-friendly output. Fleet has
   skill-security-review as a MANUAL discipline — nothing enforces it.
   Lift: install-path gate — any new skill/plugin/MCP ref entering
   skills-lock.json or .claude/ passes an inventory+static scan before
   accept; law-guard fails CI on unscanned additions. Adopt the pattern,
   not the SaaS (injector law).
4. **Benchmark-gated overnight harness-evolution loop** (verification).
   auto-harness: mine failures → edit agent code → guard regressions,
   benchmark-gated; agentic-harness-engineering: evaluate→analyze→improve
   loops over traces. Fleet: blam + oracle analyze exist but nothing ties
   them into a standing loop. Lift: nightly blam scenarios × paired arms
   on real fleet tasks (completes prior-art lift 5), oracle-bug the
   failures, auto-mint work items for regressions, benchmark gate before
   harness-behavior changes land.
5. **Classifier-gated autonomy tier + blocked detection** (governance /
   continuation). Claude Code auto mode: classifier-backed approval
   delegation for high-autonomy runs; Herdr: blocked+idle detection as a
   first-class signal. Fleet gap: the lane Bash allowlist is static
   verb-prefix (git/bun/qlty/rg/eza/sd/diff/xh) — gray-zone commands
   stall lanes with misleading errors (rm -i silent noop, 2>&1 misparse);
   governance is binary solo/strict; a stalled lane looks idle until the
   15-min transcript floor. Lift: deterministic contract first (verb +
   arg shapes), local-model classifier pass (:8902/:8903) for gray-zone
   commands only, audited; blocked-detection event nudges via steer
   (prior-art lift 4). Scope the classifier to command-shape text only —
   it reads untrusted content.

## What NOT to adopt

- **Second control planes/gateways** (LiteLLM Agent Control Plane,
  OmniRoute (68k★ list), AionUi, ClawManager): buckle/belt own the
  gateway + control-plane seam; OmniRoute's quota-aware routing
  duplicates belt ladders + buckle cooldowns (already a LiteLLM port);
  a second plane breaks one-write-authority and config-over-code.
- **Agent frameworks** (LangGraph, AutoGen, CrewAI, deepagents, MS Agent
  Framework): hide the loop our gates must own; mostly Python — foreign
  runtime; fleet law is boring/inspectable/one-obvious-path.
- **claude-mem or any plugin as an install**: prompt+code injector law;
  lift 1 re-implements the mechanism in reviewed TypeScript (same stance
  as research-oh-my-claudecode.md).
- **Always-on messaging-agent runtimes** (OpenClaw, Nanoclaw): chat
  channels + huge attack surface; zero overlap with headless fleet lanes.
- **Zero-code/visual platforms** (Langflow, Nexent, ChatDev): config
  without audit trails — conflicts with the enterprise direction.
- **Self-evolving meta-harnesses** (EvoMap, GenericAgent skill-tree,
  Meta-Harness-as-product): evidence-poor, toy benchmarks; violates the
  decision-grade benchmarks doctrine. Lift 4 is the evidence-backed
  version of the same instinct.
- **Human-approval governance suites** (Cordum, DashClaw, Tandem, Haft):
  solve approval fatigue for human-facing agents; fleet approvals are the
  owner + NEED_DECISION bus; a second decision plane adds drift.
- **AutoJunjie list as a monitoring feed**: stale since 2026-04-19; use
  Picrew's (verified 2026-10-08) for tracking, AutoJunjie for taxonomy.

## What we do that they lack

CAS work-graph claims + claim-before-spawn; mechanical law enforcement
(content/scrub gates, 1500-line law, law-guards CI, banned shell) where
list entries ship prompt-based discipline only; health-outside-process
probes (the list ecosystem watches LLM traces, almost nothing verifies
the served process from outside); secrets minted on-device with scoped
TTL'd per-lane keys; machine-parseable verdict contract + named oracle
escalation; byte-exact restore discipline (git show) and capsule resume;
config-over-code install-grade deploys from one stack.yaml.
