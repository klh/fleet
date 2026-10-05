# Swarm comms research — inter-agent mechanisms mapped against the fleet (W436)

2026-10-05 · Research only · Primary sources fetched and verified 2026-10-05
unless marked otherwise. Companion to `toto-gpt.md` ("Agent-swarm research"
section) — that document covers MAST, AgentPrune, More-Capable-Less-Cooperative
and the Five Ws for the **consult** plane specifically; this survey goes
beyond it: task allocation, shared workspaces, memory/handoff, capability
discovery, failure attribution, observability interop, and the agent-interop
protocol landscape (A2A / ACP / ANP / MCP).

Method: every claim below was checked against the cited primary source
(arXiv abstract page or protocol spec site) on 2026-10-05. Anything not
fetched directly is marked _(unverified — search-level lead)_.

## Fleet baseline (what the mapping is against)

Surfaces inspected for this doc:

- `packages/suspenders/hooks/coord/bus.ts` — append-only `events` table,
  per-session cursors (advance only past SHOWN), `poll`/`wait` adaptive
  long-poll, `subscribe` persistent WS push (`/subscribe`, reconnect
  backoff), `broadcast` (live fan-out + SessionStart injection via
  `broadcast.latest` fact), cooperative pause/resume (checkpoint SHA +
  mandatory continuation capsule).
- `hooks/coord/addressing.ts` — `coord targets` (live sessions with
  label/hub/tool/model/capabilities), `coord message` directed DM
  (event kind `NOTE`), exact/prefix/substring target resolution.
- `hooks/coord/consult.ts` + `shared.ts` — knowledge-first consults
  (lesson → KB → live expert), `--best` expert routing, `rankExperts`
  (claims 40% / done-work 25% / touches 20% / role 10% / heartbeat 5%),
  `consult-reply` harvesting every non-declined answer into `consult_kb`
  (FTS index), `who-knows`.
- `hooks/coord/facts.ts` — versioned KV facts, per-lane continuation
  capsules, `gc` retention (consults OPEN expire after 1h with **no
  notification emitted**; locks 15-min TTL; events 30d).
- `hooks/coord/fleet.ts` — bootstrap (identity + owned work + inbox +
  `--caps` capability registration), `metrics` (wall/agent time replay,
  token attribution, dwell, friction: conflicts/rework/failures,
  self-serve counts), `diff` (delta read model), `events` read verb.
- `hooks/bin/work.ts` — work graph: composite PK (project, id), state
  machine READY/CLAIMED/RUNNING/BLOCKED/PAUSED/DONE/FAILED/SUPERSEDED/
  SHATTERED/ORPHANED, CAS `take`, cycle-checked deps, `split`, `requires`
  capability requirements, `.workgraph.jsonl` mirror, `reclaim all`,
  `work fail` (free-text `--note` only — no structured cause).
- `scripts/dispatch-next.ts` — brief composition (condense pass W334,
  capsule protocol, RESUME CONTEXT from the dead lane's last capsule),
  must/prefer executor chain, capability-aware dispatch, brief
  verification per harness, per-lane `bksk_` keys. Re-dispatch reuses the
  SAME sid (`autow<item>`), so the capsule travels only with the lane,
  not the item.
- Capability vocabulary: 8 verbs (`shell fs git build mcp vision browser
network`); `work_items.requires ⊆ sessions.capabilities` enforced at
  `work take`.

Net: the fleet is already a **pub/sub + inbox hybrid with a deterministic
allocation market (CAS claim) and data-capsule handoff**. The gaps the
research exposes are small and specific.

## Comparison table

| Mechanism                                                     | Primary source                                                                                                                                                                            | What the fleet already has                                                                                                                                                            | Verdict                                                            | Integration sketch                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Pub/sub event bus with cursors + WS push                      | standard middleware pattern; fleet design                                                                                                                                                 | `events` + cursors + `coord poll/wait/subscribe` (W303)                                                                                                                               | **have**                                                           | none                                                          |
| Directed inbox messaging                                      | A2A `Message` objects; OpenAI Agents SDK handoffs (openai.github.io/openai-agents-python/handoffs)                                                                                        | `coord message` (`NOTE` kind), `inbox --ack`, consults                                                                                                                                | **have**                                                           | none                                                          |
| Conversation handoff with history transfer                    | OpenAI Agents SDK: receiver "gets to see the entire previous conversation history", reshaped by `input_filter`                                                                            | capsule + RESUME CONTEXT — data packet, not transcript                                                                                                                                | **have** (prefer data)                                             | none — capsule is the auditable `input_filter`                |
| Blackboard / shared workspace                                 | bMAS, arXiv 2507.01701; Google blackboard, arXiv 2510.01285                                                                                                                               | `facts` table is a versioned KV blackboard — but capsules are lane-scoped, work items have no shared notes surface                                                                    | **adopt-now**                                                      | per-item capsule (item 1 below)                               |
| Context consolidation / compression                           | MEM1, arXiv 2506.15841 (3.5x perf, 3.7x less memory); ACON, arXiv 2510.00615                                                                                                              | `coord capsule` ≤10 lines + `condensePrompt` (W334)                                                                                                                                   | **have**; learned compression = adopt-later                        | none now                                                      |
| Knowledge evolution / linking                                 | A-MEM, arXiv 2502.12110 (Zettelkasten notes, linking, back-updates)                                                                                                                       | `consult_kb` harvest + FTS — but harvest inserts **unconditionally** (consult.ts), no dedup                                                                                           | **adopt-now** (dedup); linking = adopt-later                       | item 2                                                        |
| Task lifecycle states                                         | A2A "Life of a Task": interrupted `input-required`/`auth-required`, terminal `completed`/`canceled`/`rejected`/`failed`; `contextId` groups tasks; terminal is immutable                  | work-item state machine is a superset (deps, shatter, supersede); `NEED_DECISION` = input-required; `bksk_` = auth                                                                    | **have**                                                           | mapping table only if/when A2A surface is built (adopt-later) |
| Capability discovery                                          | A2A Agent Card (name/url/capabilities/auth/skills; `/.well-known/agent-card.json`, RFC 8615); ANP Agent Description                                                                       | `sessions.capabilities` + `requires` check at take + `coord targets --json` — but no capability filter anywhere                                                                       | **adopt-now** (filter); card endpoint = adopt-later                | item 5                                                        |
| Market / auction / Contract-Net allocation                    | Contract Net: Smith 1980 (IEEE Trans. Computers C-29(12)); LLM-MR-CNP, arXiv 2608.12371; AgentLance, arXiv 2608.23867; Agora-auction, arXiv 2607.09600 _(unverified — search-level lead)_ | READY pool + CAS `take` = zero-message first-price claim; `requires ⊆ capabilities` = bid admissibility; `conflict` events already counted in metrics                                 | **skip** (revisit trigger: sustained conflicts in `coord metrics`) | none                                                          |
| Structured failure attribution                                | Who&When, arXiv 2505.00212: best automated method 53.5% agent-level, 14.2% step-level; MAST, arXiv 2503.13657 (covered in toto-gpt.md)                                                    | deterministic claim-segment replay (`workTiming`), friction metrics; `work fail --note` free text                                                                                     | **adopt-now** (structured `--cause`); automated judge = **skip**   | item 3                                                        |
| Consult outcome measurement                                   | Five Ws (arXiv 2602.11583, toto-gpt.md); Optima's efficiency rewards, arXiv 2410.08115                                                                                                    | metrics self-serve counts (kb/lesson) — but no applied/rejected outcome, and expired consults notify nobody                                                                           | **adopt-now**                                                      | item 4                                                        |
| Swarm observability interop                                   | OTel GenAI semantic conventions (moved to github.com/open-telemetry/semantic-conventions-genai: agent spans, events, metrics, MCP); AgentSight, arXiv 2508.02736                          | board + `coord metrics` + `coord diff/events` + probe sidecars (health outside-process)                                                                                               | **adopt-later** (OTel mapping); eBPF boundary tracing = **skip**   | none now                                                      |
| Communication-topology optimization                           | GPTSwarm, arXiv 2402.16823; G-Designer, arXiv 2410.11782 (up to 95.33% token cut); Optima, arXiv 2410.08115 (2.8x perf, <10% tokens); + AgentPrune/DyLAN (known)                          | topology is already the pruned endpoint: kb-first consult to ONE expert, broadcast discipline, no lateral chatter                                                                     | **skip**                                                           | none                                                          |
| Open agent networks (DID identity, meta-protocol negotiation) | ANP white paper, arXiv 2508.00007 (identity/encrypted-comm, meta-protocol, application layers)                                                                                            | `bksk_` minted keys + git-dir project identity; A2A+ACP consolidated under Linux Foundation (ACP merge into A2A Aug 2025 _(reported — second-tier)_; AAIF _(reported — second-tier)_) | **skip** now; A2A-shaped surface = adopt-later                     | none now                                                      |
| SOP / assembly-line role structure                            | MetaGPT, arXiv 2308.00352 (SOP-encoded prompts, role assembly line, intermediate verification)                                                                                            | dispatch briefs + AGENTS.md protocol + gates                                                                                                                                          | **have**                                                           | none                                                          |

## Adopt-now (mintable as work items)

1. **Per-item continuation capsule** — `coord capsule set --as <sid>
--item <W-id> …` writes fact `work.<id>.capsule` alongside the
   lane-scoped `lane.<sid>.capsule`; `work show <id>` prints it;
   `composeBrief` injects it as RESUME CONTEXT for **any** claimer.
   Today the capsule travels only with the reused sid — an item reclaimed
   via `work reclaim all` and taken by a fresh lane starts blind.
   Research mapping: blackboard shared workspace (bMAS 2507.01701), A2A
   `contextId` grouping (context survives task turnover), MEM1-style
   consolidation (the capsule IS the consolidated state). Touch points:
   `hooks/coord/facts.ts` (cmdCapsule), `hooks/bin/work.ts` (show),
   `scripts/dispatch-next.ts` (composeBrief).

2. **consult_kb harvest dedup** — `cmdConsultReply` inserts every
   non-declined answer into `consult_kb` unconditionally; `coord gc`
   never prunes kb. Before insert, run the existing `kbLookup(question)`;
   on a hit, bump `hits`/`last_hit_at` and merge (append solution
   refinement) instead of inserting a near-duplicate row. Research
   mapping: A-MEM's memory evolution (new notes update old ones),
   AgentPrune's redundancy pruning. Inspectable one-file change in
   `hooks/coord/consult.ts`; kb stats line already exists to show the
   effect.

3. **Structured failure cause on `work fail`** — add `--cause
<spec|misalign|verification>` (MAST's three top-level categories) and
   optionally `--step <n|description>`; carried on the `work.failed`
   event payload; `coord metrics` friction line and the board friction
   panel break failures down by cause. Deliberately a **self-report at
   fail time**, not an LLM judge: the best published automated
   attribution is 53.5% agent-level / 14.2% step-level (Who&When,
   2505.00212), while the failing lane knows the step it died on.
   Touch points: `hooks/bin/work.ts` (fail handler — currently free-text
   note only), `hooks/lib/govdb.ts` (metrics), board work-card.

4. **Consult outcome + expiry telemetry** — `coord consult-reply
<C##> "<answer>" --outcome applied|rejected` (default `applied`,
   back-compat) stores outcome on the consult row; `coord gc`, when it
   expires OPEN consults after 1h, emits a `consult.expired` event to
   the asker (currently expiry is silent — a question that died is
   invisible); `coord metrics` gains an outcomes line (applied /
   rejected / expired alongside the existing kb+lesson self-serve
   counts). Research mapping: Five Ws "what decision did this change";
   makes the consult plane's usefulness measurable instead of assumed.
   Touch points: `hooks/coord/consult.ts`, `hooks/coord/facts.ts` (gc),
   `hooks/coord/fleet.ts` (metrics).

5. **Capability-filtered discovery** — `coord targets --cap <c>` filters
   live targets on `sessions.capabilities`; `work ready --json` gains a
   `requires-match` hint per item (which live lanes could take it). No
   new state: both read columns that already exist. Research mapping:
   A2A Agent Card skill discovery and Contract-Net contractor
   advertisement, done in-process. Touch points:
   `hooks/coord/addressing.ts` (cmdTargets), `hooks/bin/work.ts` (ready).

## Adopt-later (trigger-conditioned, not now)

- **A2A-shaped read-only fleet card** — board endpoint (e.g.
  `GET /api/fleet/cards`) projecting `work lanes --json` +
  `sessions.capabilities` into Agent-Card-shaped JSON; only when an
  external counterpart agent actually exists (enterprise product
  boundary). Includes the A2A↔work-graph state mapping (READY→submitted,
  RUNNING→working, NEED_DECISION→input-required, DONE→completed,
  FAILED→failed). Not before: no counterpart, and a second lifecycle
  machine beside the work graph violates boring-inspectable.
- **OTel GenAI semantic-convention mapping** — map `coord events` kinds
  and belt/buckle proxy traces onto `gen_ai.*` agent spans/events for
  enterprise observability interop. Conventions live in
  `open-telemetry/semantic-conventions-genai` (agent spans, MCP, metrics)
  and are still evolving — wait for stability; export mapping only, no
  new collection infra.
- **Learned capsule/brief compression (ACON-style)** — only if capsule or
  brief size becomes a measured pain; `condensePrompt` + ≤10-line capsule
  law already cap the surface.
- **kb linking / graph view (A-MEM-style)** — beyond dedup: cross-links
  between kb rows by scope/project. Only if kb search quality degrades
  after dedup lands.
- **Content-aware dispatch (blackboard dynamic agent selection)** —
  replace FIFO ready-pick with blackboard-content-driven selection only
  if `coord metrics` shows capability-matched lanes starved.

## Don't adopt (with reasons)

- **Auction / market task allocation** (LLM-MR-CNP 2608.12371, AgentLance
  2608.23867, Agora-auction 2607.09600). The CAS `take` is already a
  zero-message first-price auction; bidding adds negotiation rounds that
  AgentPrune exists to prune. LLM-MR-CNP's own headline is that the gain
  sits in multi-round negotiation over _qualitative runtime context_ —
  fleet work is repo work whose hard constraints are enforced by qlty
  gates (their "deterministic validation" layer), and cost heterogeneity
  is already handled by the `.prefer` must/prefer chain. Revisit only if
  `coord metrics` shows sustained claim conflicts.
- **Automated LLM failure attribution** (Who&When methods, 2505.00212).
  53.5% agent / 14.2% step accuracy is below a lane's own
  `--cause`/`--step` self-report, which is free and deterministic.
- **eBPF boundary tracing** (AgentSight, 2508.02736). New always-on infra
  with root/kernel probes to re-derive what the plane already records
  (events, deltas, claims) — no-new-infra-without-measured-need; the
  outside-process principle is already served by probe sidecars.
- **Communication-topology optimization** (GPTSwarm 2402.16823, G-Designer
  2410.11782, Optima 2410.08115, DyLAN, AgentDropout). These optimize
  lateral-chatter graphs for benchmark accuracy; the fleet has no lateral
  chatter to optimize — its topology is the post-pruning endpoint
  (kb-first, one expert, broadcast discipline). Optima's actual lesson
  (token efficiency + readability rewards) is already institutionalized
  as condensePrompt + the terse-voice law.
- **DID-based open identity / meta-protocol negotiation** (ANP
  2508.00007). Trust domain is one fleet over known hubs: minted
  `bksk_` keys + git-dir project identity cover it. DID/PKI adds
  infrastructure with no counterpart network to interoperate with.
- **A2A/ACP wire-protocol adoption now** (a2a-protocol.org; ACP,
  agentcommunicationprotocol.dev). No external counterpart agents; would
  duplicate the work graph's lifecycle. Revisit as the read-only card
  surface above. (Status notes: ACP merged into A2A and both moved under
  a Linux-Foundation Agentic AI foundation are _reported by second-tier
  sources only_ — re-verify against the spec sites before relying.)
- **Full blackboard orchestration with content-based agent selection**
  (bMAS 2507.01701; Google blackboard 2510.01285 — which explicitly
  removes the coordinator's knowledge of agent expertise). Replacing the
  deterministic READY-pool + CAS + capability-requirement allocation with
  content-triggered scheduling makes the core loop opaque — the opposite
  of boring, inspectable, one obvious path.
- **RL-trained memory consolidation (MEM1) / learned compression (ACON)
  now.** Training pipelines for marginal gains on a ≤10-line capsule.
  Adopt-later behind a measured trigger.

## Sources (primary, fetched 2026-10-05)

- bMAS blackboard MAS — arXiv:2507.01701
- Google blackboard for information discovery — arXiv:2510.01285
- MEM1 — arXiv:2506.15841
- A-MEM — arXiv:2502.12110
- ACON — arXiv:2510.00615
- Who&When / automated failure attribution — arXiv:2505.00212
- MAST — arXiv:2503.13657 (covered in toto-gpt.md)
- Five Ws of multi-agent communication — arXiv:2602.11583 (toto-gpt.md)
- GPTSwarm — arXiv:2402.16823 · G-Designer — arXiv:2410.11782 ·
  Optima — arXiv:2410.08115
- LLM-MR-CNP (MAS-DecStream) — arXiv:2608.12371 · AgentLance —
  arXiv:2608.23867 · Agora-auction — arXiv:2607.09600 _(unverified —
  search-level lead)_
- A2A: Life of a Task + Agent Discovery — a2a-protocol.org
- ANP white paper — arXiv:2508.00007 · ACP docs —
  agentcommunicationprotocol.dev
- OpenAI Agents SDK handoffs — openai.github.io/openai-agents-python/handoffs
- OpenTelemetry GenAI semantic conventions —
  github.com/open-telemetry/semantic-conventions-genai
- AgentSight — arXiv:2508.02736
- MetaGPT — arXiv:2308.00352 (abstract-level: SOPs, assembly line,
  intermediate verification; the message-pool detail is in the paper body,
  not verified here)
- Contract Net Protocol — R.G. Smith, IEEE Trans. Computers C-29(12),
  1980 (classic reference)
