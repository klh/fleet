# Research: CrewAI memory + Dosu organizational context — reuse map for Fleet

Item W1124.18.4 · 2026-10-23 · lane autow1124-18-4 · research-only (no
implementation/deploy changes from this item).

Method: primary sources only. CrewAI read at source
(`crewAIInc/crewAI` main @ `07361f6dc5f96d22efe565ff89297d22bce4a90f`,
cloned 2026-10-23; monorepo layout `lib/crewai`, `lib/crewai-core`,
`lib/crewai-files`, `lib/crewai-tools`, `lib/cli`, `lib/devtools`).
Dosu public surface inventoried via the GitHub API + raw file fetches the
same day. Fleet side read in this repo. Marketing pages were not used as
evidence; product claims below are Dosu's own CLI contract text.

## Verdicts up front

1. CrewAI is MIT; nothing in its memory subsystem is importable into
   Fleet (Python vs TS/Bun) — the reuse is **pattern-level only**.
2. The CrewAI memory story changed underneath its own docs: the
   short-term/long-term/entity triad is deleted on main; one unified
   `Memory` with batch encoding + adaptive recall replaced it.
3. Dosu's licensed, reusable code is `decant` — and Fleet already
   vendors it (`packages/decant`, v0.11.0, W950). The org-context
   product (Library/Agent/Monitor/review-queue) is closed SaaS:
   **ideas only**, no reusable code exists.
4. Dosu `abbs` (Apache-2.0) is a sanctioned agent-coordination board —
   a protocol Fleet's coord plane already implements internally.
5. One actionable adoption: importance-weighted recency decay in the
   knowledge ranking (from CrewAI scoring) — plus one watch-item:
   consolidation-at-curate via the local embeddings specialist.

## CrewAI: license and package layout

- **License: MIT.** `LICENSE` line 1: `Copyright (c) 2025 crewAI, Inc.`
  followed by the standard MIT grant; GitHub API `license.spdx_id=MIT`
  (repo `crewAIInc/crewAI`, 60,038 stars, pushed 2026-10-23). MIT imposes
  only attribution (license + copyright notice preservation) — no
  copyleft, no network clause. Nothing blocks pattern reuse or a port.
- The repo restructured into a **uv workspace monorepo** (`lib/`):
  `crewai` (the framework package), `crewai-core` (settings/paths/telemetry
  shared kernel), `crewai-files`, `crewai-tools`, `cli`, `devtools`.
  Memory lives in `lib/crewai/src/crewai/memory/`.
- Memory-relevant dependencies of the `crewai` package
  (`lib/crewai/pyproject.toml`): `chromadb~=1.5.9` is a **core** runtime
  dep — but it serves the separate **Knowledge** feature and the RAG
  chassis (`src/crewai/rag/*`, `src/crewai/knowledge/storage/
  knowledge_storage.py`), NOT the memory subsystem; and `mem0` is an
  optional extra (`mem0 = ["mem0ai>=2.0.0,<3"]`, line 72) with **zero
  in-tree imports** — the mem0 "ExternalMemory" integration is vestigial
  on main. Memory's default storage is LanceDB (local embedded, no
  server), declared in code, not as a pyproject dep name here.

## CrewAI: the memory subsystem as main actually has it

Docs and blog posts still describe a three-store memory
(short-term ChromaDB / long-term SQLite / entity). **That triad no
longer exists on main**: `rg ShortTermMemory|LongTermMemory|EntityMemory`
over the whole clone returns zero hits. What replaced it, file by file
(`lib/crewai/src/crewai/memory/`):

| component | file | what the source does |
| --- | --- | --- |
| `Memory` (unified) | `unified_memory.py` | single store, LLM-analyzed saves, standalone-usable (no crew required); weights `recency 0.3 / semantic 0.5 / importance 0.2`, recency half-life 30 days, consolidation threshold 0.85 |
| EncodingFlow | `encoding_flow.py` | batch-native write pipeline, 5 steps: ONE batch embed → intra-batch cosine dedup → parallel similar-search → N concurrent LLM analyses (field resolution + consolidation plans) → batch re-embed + bulk insert |
| RecallFlow | `recall_flow.py` | "RLM-inspired" adaptive-depth retrieval: LLM distills query into 1-3 sub-queries + scope hints + time filter (`QueryAnalysis`), parallel multi-scope search, composite-scored, then confidence-based iterative deepening under an exploration budget; evidence gaps tracked into results |
| analysis schemas | `analyze.py` | `MemoryAnalysis` (scope/categories/importance/entities/dates/topics) on save; `ExtractedMemories` (discrete self-contained statements) |
| scope views | `memory_scope.py` | hierarchical path scopes: crews get `root_scope=/crew/<id>`, flows `/flow/<name>`; `MemoryScope`/`MemorySlice` are views over one backing store |
| storage backends | `storage/` | `StorageBackend` port; LanceDB default (local embedded), `qdrant_edge_storage.py`, `kickoff_task_outputs_storage.py` (SQLite WAL, `latest_kickoff_task_outputs.db`) |
| agent tools | `tools/memory_tools.py` | `RememberTool` / `RecallMemoryTool` — the agent reads/writes memory mid-run as plain tools |

### The runtime lifecycle (source-verified)

1. **Init**: `Crew.create_crew_memory()` (`crew.py:658`) — `memory=True`
   mints `Memory()` with a hierarchical `root_scope` derived from the
   crew id; flows do the same at
   `flow/runtime/__init__.py:893-897` (`Memory(root_scope=f"/flow/
   {flow_name}")`).
2. **During the run**: agents save through their own `agent.memory`
   (`BaseAgentExecutor._save_to_memory`), each save running the
   EncodingFlow; the agent can also call `RememberTool`/
   `RecallMemoryTool` explicitly. Everything is background/threaded —
   the critical path never blocks on memory.
3. **Boundary**: `Crew._drain_memory_writes()` (`crew.py:1908`) blocks
   until all pending background saves finish — and it drains crew +
   per-agent + manager pools, scope views unwrapped to their backing
   store — **before** `CrewKickoffCompletedEvent` emits, so downstream
   listeners (telemetry sessions) never observe an orphaned save span.
4. **Recall** happens on demand via RecallFlow; a low-confidence first
   pass triggers iterative deepening, not a bigger fixed context dump.

Reading of "memory as a cognitive runtime process": in current CrewAI
this is concretely **two flows + a scoring function + a drain barrier**,
not a store. The cognition lives in (a) LLM analysis at encode and
query time, (b) confidence-gated deepening at recall, (c) composite
scoring replacing hand-tuned top-k.

## Dosu: what is actually public

Public non-fork repos under `github.com/dosu-ai` (GitHub API,
2026-10-23):

| repo | license | state | what it is |
| --- | --- | --- | --- |
| `decant` | Apache-2.0 | active (pushed 2026-10-21, 70 stars) | local-first analysis of Claude Code/Codex/Gemini CLI/OpenCode sessions: token spend, context windows, files touched, cost; SQLite archive + FTS |
| `dosu-cli` | MIT declared in `package.json` only — **no LICENSE file** (GitHub license detection = null) | active (pushed 2026-10-22) | OAuth login, MCP-server wiring into Claude Code/Cursor/Codex, platform commands, bundled agent skill |
| `abbs` | Apache-2.0 | active Aug 2026 | "Agent Bulletin Board System" — self-hostable thread board + open protocol for agent coordination, born from the July 2026 HF-intrusion incident |
| `better-stale-bot` | Apache-2.0 | active Aug 2026 | AI stale-issue bot on GitHub Agentic Workflows |
| `homebrew-dosu`, `community`, `assets`, `.github` | — | mixed | packaging + meta |

`dosu-skill` is **archived**; the skill now ships inside `dosu-cli`
(`skills/dosu/SKILL.md`). MIT declared but no license file is a
packaging smell: usable, but pin the commit you take text from.

### The proprietary core (ideas only — no public code)

From Dosu's own CLI contract (`skills/dosu/SKILL.md`, fetched verbatim):

- **Organization** = permission boundary; **Library** (internal name
  `space`) = the knowledge container; **data sources** = org-level
  connections (repo/Slack/Notion) attachable to any Library.
- **Agent** = a GitHub/GitLab/Slack/Teams deployment serving exactly
  ONE Library; each data source can back at most one Agent (409
  CONFLICT otherwise).
- **Monitor** = per Library+source; reviews pull requests "to keep the
  Library's knowledge up to date" — knowledge freshness as a PR gate.
- **Review queue** = pending doc changes + draft replies requiring
  one-item-at-a-time human approve/reject, with an explicit
  `--confirm` preview contract (`{confirmRequired, applied:false}` =
  nothing happened).
- `dosu ask` / `dosu knowledge search` = the retrieval+synthesis
  surface. The engine behind it is closed; no docs describe its
  internals.

### Fleet already reuses the one licensed component

`packages/decant/` is a **vendored dosu-ai/decant v0.11.0** snapshot
(Apache-2.0; `LICENSE` + `NOTICE` kept verbatim; vendored 2026-10-19
under W950). Per `packages/decant/FLEET.md`: upstream distribution
automation excluded, upstream test suite (119 files, 1,444 tests) kept
as the parity net, all fleet changes quarantined in
`packages/decant/fleet/` (`registry.ts` session-source registry,
`after-sync.ts` adapter minting, `confidence.ts` ingest-time confidence
stamp `{value:0.4, setter:"mechanical:decant", verdict:"fresh"}` written
by an AFTER INSERT trigger). The unencrypted-archive caveat (transcripts
+ tool output in `~/.decant/decant.db`, 0600) is documented there too.
So the mission's "distinguish proprietary ideas vs licensed reusable
code" question has a concrete answer: **the licensed code is decant and
it is already inside the fence; the org-context product is ideas only.**

## Mapping to the Fleet context pipeline

Fleet's existing surfaces (all read in this repo):

- `coord fact` (facts + knowledge.db, FTS5 bm25 + age-decay ranking;
  live scale 2026-10-01: 229 knowledge rows, 1,999 facts, 76
  consult_kb — `docs/design/knowledge-db-2026-10-01.md`)
- `coord consult` / consult_kb — questions to peers, answers banked
- decant (vendored, above) — session analytics = the **cost ledger**
- `knowledge-curate` / knowledge-sync / knowledge-buckle (W1218
  buckle-verified knowledge) / hub knowledge sink (W1213)
- W142 knowledge arch: verified-only preseed + metered aids + coord
  write-back (owner decision)

### CrewAI ideas worth adopting (and their DRY boundaries)

1. **Importance-weighted recency decay** — CrewAI scores candidates
   `0.5·semantic + 0.3·recency(half-life 30d) + 0.2·importance`.
   Fleet already has bm25 + age-decay; the missing axis is
   importance. DRY path: add an optional importance weight to the
   knowledge ranking in `hooks/lib/knowledge.ts` (one formula, one
   place), sourced from kind (lesson/incident > fact) — no new store,
   no new pipeline. Acceptance: rerun the 20-query bench harness from
   the knowledge-db doc; relevance A/B on banked queries, p95 search
   latency regression capped at 20%.
2. **Consolidation-at-curate** — CrewAI merges near-duplicates at
   save time (cosine ≥ 0.85 → LLM consolidation plan). Fleet already
   detects near-dups (`findNearDuplicate` in knowledge.ts) but never
   merges. DRY path: keep the write path mechanical (W142: verified
   only), do consolidation inside `knowledge-curate` only, LLM leg
   routed through the local swarm (`:8903` reason / `:8907`
   embeddings), metered. Acceptance: curated merges reduce fact
   count ≥10% on a real corpus slice with zero active-state losses.
3. **Adaptive-depth recall** — confidence-gated deepening beats
   fixed top-k dumps. Fleet's analog decision (search more vs ask a
   peer vs give up) is currently implicit. Read-path pattern only;
   adopt later if `read_knowledge` miss telemetry shows gaps. No
   change recommended now.
4. **Drain-at-boundary** — CrewAI drains background memory writes
   before the completion event so listeners never see partial state.
   Fleet equivalent already exists (decant AFTER INSERT trigger in
   the same transaction; hub sink batching). Nothing to adopt.

### Dosu ideas worth adopting

1. **Monitor-as-PR-gate** (knowledge freshness from code review) —
   the idea maps onto Fleet as: land a knowledge-update suggestion
   into the same review/curate queue as everything else, never a
   direct write. Fleet's W142 arch already mandates this; Dosu's
   contribution is the UX proof that reviewers only scale if the
   queue is per-Library and batched. Watch, don't build.
2. **Library-attached-sources topology** — knowledge container with
   explicitly attached org sources (repo/Slack/Notion), agents bound
   1:1 to a container. Fleet's analog is domain/area keys on facts;
   no new mechanism needed. If hub federation ever needs
   container-level access control, this is the shape to copy.
3. **`abbs` as an open coordination protocol** — Fleet's coord plane
   (WS bus, inbox, consult, acks, signed sessions) already implements
   a richer superset. `abbs` matters only as a potential
   interop target for cross-org agent boards. Keep on the radar;
   nothing to import (Go server, and the auth model is board-local).
4. **`dosu-cli`'s agent-skill distribution pattern** — skill bundled
   with the CLI, re-applied on upgrade (`dosu skill update`), skill
   text = CLI contract. Fleet's `skills/` catalog + `npx skills add
   klh/fleet` already covers this; the one borrowed idea: regenerate
   skill text from the CLI's own command registry so they can't
   drift (single source).

## Reuse recommendations (ranked)

| # | action | license/source | cost | acceptance |
| --- | --- | --- | --- | --- |
| 1 | importance axis in knowledge ranking | CrewAI pattern (MIT, pattern-level) | small: one formula in `knowledge.ts` + test | 20-query bench rerun: relevance up or equal, p95 +≤20% |
| 2 | consolidation-at-curate, local-LLM leg | CrewAI pattern (MIT, pattern-level) | medium: curate-side only, metered | ≥10% fact-count reduction on a corpus slice, zero active-state losses |
| 3 | keep decant vendored; recheck upstream quarterly | Apache-2.0, already vendored | none (existing W950 policy) | `FLEET.md` pin stays ≤1 minor behind upstream |
| 4 | skill-text generation from CLI registry | dosu-cli pattern (MIT) | small; touches `skills/` catalog | skill refs match `work --help`/`coord --help` output |
| 5 | adaptive-depth recall | CrewAI pattern | none now | only if read_knowledge miss telemetry appears |
| 6 | abbs interop | Apache-2.0 (Go) | none now | only if cross-org federation is requested |

Not recommended: importing any CrewAI Python (language mismatch, no
Fleet consumer); adopting the Dosu Library/Agent/Monitor SaaS surface
(closed engine, cloud path, violates the LAN-first posture); adding
mem0 (vestigial upstream, another vendor dep).

## Provenance / privacy / security constraints

- **Cloud egress**: CrewAI's memory defaults are an OpenAI embedder
  and a cloud LLM for per-item analysis (`unified_memory.py`
  `_default_embedder()`, `llm="gpt-5.4-mini"` default). Any Fleet
  adoption of the pattern MUST route the analysis/embedding legs
  through the local belt swarm / buckle gate. Never adopt defaults.
- **IKEA content**: stays in coord facts `finding.ikea-*` only —
  machine-local, never in repo docs (standing law).
- **decant archive**: unencrypted SQLite at `~/.decant/decant.db`
  holding transcripts + tool output; 0600; retention-policy subject.
  Already documented in `packages/decant/FLEET.md`; no change.
- **`dosu-cli` has no LICENSE file** — MIT only via `package.json`.
  If Fleet ever vendors text from it, pin the exact commit and carry
  the notice; do not assume GitHub license detection.
- **abbs public-board mode is unauthenticated-by-design** — a
  sanction of improvisation, not a security model. Fleet coord stays
  behind the buckle gate + scoped keys.

## Cost/quality measurement plan (measurable acceptance)

The "repeated context-gathering cost" is already instrumented in
Fleet:

- per-item token/cache/out-min ledger (W776 attribution) — the
  baseline for any before/after comparison;
- consult events per item (W909 links) — the direct measure of
  repeated context-gathering;
- decant rollups per session — wall-time + token spend per work item;
- knowledge search latency + relevance — the 20-query bench harness
  from `docs/design/knowledge-db-2026-10-01.md`.

Any adopted item above must move one of: consult-events-per-item
down, context re-reads per item down, or search relevance up —
without regressing p95 search latency beyond 20%. Decant per-item
rollups are the before/after instrument; no new telemetry needed.

## Citations

- crewAIInc/crewAI main @ `07361f6dc5f96d22efe565ff89297d22bce4a90f`
  (2026-10-23): `LICENSE`; `lib/crewai/pyproject.toml` (chromadb
  core dep line 27, mem0 extra line 72); `lib/crewai/src/crewai/
  memory/{unified_memory,encoding_flow,recall_flow,analyze,
  memory_scope}.py`; `src/crewai/crew.py` (`create_crew_memory`
  :658, `_drain_memory_writes` :1908); `flow/runtime/__init__.py`
  :890-897; `tools/memory_tools.py`; `knowledge/storage/
  knowledge_storage.py`; zero-hit grep for
  `ShortTermMemory|LongTermMemory|EntityMemory` across the clone.
- dosu-ai org repos via GitHub API 2026-10-23: `decant`
  (Apache-2.0, pushed 2026-10-21); `dosu-cli` (pushed 2026-10-22;
  README license section: "MIT — see the `license` field in
  package.json"); `abbs` README (self-hostable agent board; HF
  incident links); `dosu-skill` README ("archived ... now lives in
  dosu-ai/dosu-cli"); bundled `skills/dosu/SKILL.md` (Library/
  Agent/Monitor/review-queue semantics).
- Fleet: `packages/decant/FLEET.md` + `README.md` (v0.11.0 pin,
  W950, Apache-2.0, fleet/ adapter layer, archive caveat);
  `hooks/lib/knowledge.ts` (ftsTerms/knowledgeSearch/
  findNearDuplicate); `docs/design/knowledge-db-2026-10-01.md`
  (store scale, 20-query bench method).
