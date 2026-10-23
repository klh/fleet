# Knowledge lifecycle contract (W1224)

The ONE contract every knowledge face obeys. W1218 (Buckle-verified query
faces), W1220 (decant dual-write) and W1225 (lane-brief injection) build
against THIS document, not against code archaeology. Design lineage:
CrewAI's staged-memory lifecycle (memory writes pass through named stages,
never ad-hoc) plus Dosu's provenance discipline (every claim carries where
it came from and a mechanical verification path). Fleet deltas are the two
owner laws this contract keeps: canonical ownership stays machine-local,
and evidence gates replace truth claims. No new framework, no new DB —
every stage below maps onto faces that already exist.

## Stores (exactly four)

| store                                                     | holds                                                                  | mutability                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| governor.db `facts`                                       | control-plane state facts + W1212 CAS'd knowledge claims               | mutable slot per key (CAS `--if-version`), latest-per-key wins |
| governor.db `consult_kb` (+ `consult_trust`)              | answered consults (problem→solution), kb add seeds, harvest rows       | append-only                                                    |
| knowledge.db `knowledge` / `knowledge_queue` / `_proposals` | distilled-claims ledger + durable broker                              | rows append-only; only state transitions mutate                |
| hub sink (W1217)                                          | aggregated replica of both knowledge classes, keyed by origin           | replica — never authoritative                                  |

decant's archive (`~/.decant/decant.db`) is machine-local session
EVIDENCE — an input to capture, never itself a knowledge store. Its
content never crosses a machine boundary (W944 class policy).

## The eight stages

`capture → propose → validate → consolidate → recall → inject → invalidate → measure`

Every face maps to ONE primary stage. No face writes past a stage's gate,
and a stage with no gate is named as gate-free (recency decay proposals
are gate-free PROPOSALS — a human still disposes them).

### capture — raw evidence enters a durable broker

Entry is always a DURABLE, inspectable broker row — never a direct
knowledge-row write from a producer.

- `coord knowledge-enqueue` / `knowledge-api POST /enqueue` →
  `knowledge_queue` (payload + hints; the declared `source_ref` FILE is
  hashed at enqueue time — the producer had repo access, the distiller
  never does).
- `work done` → `queueCompletionKnowledge` (lib/work-knowledge.ts): the
  completion receipt rides the queue; kev-curation's verdict gates noise
  before enqueue.
- `coord fact set [--if-version n]` → governor.db `facts`: control-plane
  state AND (W1212) decant's daily CAS'd knowledge claims —
  content-addressed keys so restatements version, not collide.
- answered consult → `consult_kb` (coord/consult.ts; W953 0.6 model stamp
  with the consult link as evidence); `coord kb add` seeds directly;
  harvest rows land the same shape.
- knowledge-sync (spoke→hub, W944): `lesson.*`/`finding.*` facts cross
  AFTER `redactSecrets`; they land on the hub as CANDIDATE knowledge rows.
- W1212 decant daily (machine-local sessions → CAS'd facts claims) and
  W1220 (the same day's roll pushed upward, fail-open) are capture faces
  by this definition.

### propose — distill payload into candidate claims

The knowledge-worker daemon (or `--once`) claims queue rows and runs the
ONLY distill path: Buckle-routed single-model pass → `parseDistill` canon
clamps (topic ≤80, fact ≤400, confidence 0..1) → `redactSecrets`
(mechanical secrets pass; a private-key block rejects the whole
candidate) → near-duplicate gate (older row kept, skip noted,
NearDupProposal) → substitution contract (W103: never store what one doc
already teaches — pointer-ize to `source_ref` + residue, or reject) →
rows land `state='candidate'`.

The distiller extracts; it never judges truth. `supersedes_id` is honored
only when the source text DECLARES the correction. The distill prompt is
config-over-code (`KNOWLEDGE_PROMPT_FILE`); its sha256 is the parser
version the W244 reprocess checkpoint compares against.

### validate — activation and grading are evidence-gated

- Promote is the activation gate: `coord knowledge-promote <id>` (the
  W142 human gate) is the ONLY transition candidate→active. A wire
  (knowledge-sync) can never activate a row.
- The W953 confidence doctrine grades every quality-bearing row:
  policy-trust bands (machine-raw → human-reviewed), stamp = {value,
  setter, ts, evidence, prior}, append-only `confidence_history`,
  sha256-chained (tamper-evident). 0.8 requires an INDEPENDENT reviewer
  (different model family), 0.9 diverse checks, 1.0 human. Below
  `CANDIDATE_THRESHOLD` (0.6) a row is never auto-trusted.
- `coord knowledge-grade` (W836) stamps audit {rating, evidence,
  researched_at} provenance on a row.
- `coord knowledge-verify` / `trustOf`: the mechanical trust check —
  re-hash the `source_ref` file and compare `source_hash`: `verified` /
  `drift` / `unverified`. Trust is permission-to-act, not truth.
- consult answers carry `consult_trust` (version-scoped).

### consolidate — dedupe, correct, pointer-ize, decay

- Substitution contract (W103) at ingest; `coord knowledge-curate` flags
  single-file-derivable rows for human review (flagging is NOT freshness —
  contributors notes append without an `updated_at` bump).
- Near-dup: `dedupeCheck` keeps the older row; the skipped candidate rides
  a NearDupProposal a human disposes (W246).
- Corrections create a NEW row via `supersedes_id`; `duplicate_of` marks
  merged twins. History stays walkable.
- Decay sweep (W208): `planDecayProposals` scores rows (exponential
  half-life, un-reviewed rows decay 2×) → open `knowledge_proposals` → a
  human disposes (approve retires, dismiss starts a 30-day cooldown).
  The engine never retires anything by itself.

### recall — one search implementation, ranked and gated

`knowledgeSearch` (lib/knowledge.ts) is the ONE implementation across the
three stores (knowledge → facts → consult_kb), consumed by `coord
knowledge`, the MCP face and the HTTP face alike.

- bm25 rank + age penalty + origin_kind prior; live states only
  (retired/graveyard NEVER rank); `minConfidence` floor — an unrated row
  cannot demonstrate it clears a floor, so it is excluded, honestly.
- 1-hop pointer-graph expansion (W245): neighbors joined by SHARED
  PROVENANCE (same source_ref, or domain+area), never text similarity.
- Every rendered card carries: state, confidence band glyph + value (or
  "unrated"), age, mechanical hash trust, 1-hop/via marker, and the
  precedence preamble — knowledge is context, never a constraint on the
  objective.
- Anonymous-call hygiene (W181 F2): refs/hashes are scrubbed from
  unauthenticated output; scope filters exclude the untaggable aux stores
  (facts carry no scope tags — private intel can never surface in a
  scoped search).

### inject — pointer-grade, precedence-first

- `read_knowledge` MCP tool (bin/knowledge-mcp.ts) — any harness; prose
  cards only, never a JSON blob to a model.
- `knowledge-api POST /search` — the same cards + JSON hits for
  programmatic consumers.
- The standing trigger rule (hooks/rules/fleet-knowledge.md) + the
  W113 finding: injection value rides FILE-LEVEL pointers, not restated
  facts.
- `coord fact get lesson.*` reads and consults answered to you are
  just-in-time injection; the W953 surface matrix gates USE, not display:
  board/search 0, lane-brief 0.6, consult 0.8, benchmark 0.8, policy 1.0.

### invalidate — state change with a reason, never a delete

- `coord knowledge-retire <id> [--superseded-by <id>]` — live → retired
  with the walkable link.
- `coord knowledge-graveyard <id> --reason "..."` — integrity-flagged or
  rejected rows are BURIED (state + `graveyard_reason` on the row),
  append-only, excluded from ranking and curation scans forever.
- Decay dispose approve → retire. Tombstones on CAS'd facts claims ride
  the W1212/W1213.3 semantics: monotonic, idempotent replay.
- `fact rm` deletes a facts KEY — allowed for session-scoped keys
  (`lane.*` prunes itself) and control-plane corrections that never
  carried knowledge-plane weight; it is NEVER applied to consult_kb or
  knowledge rows.
- W244 reprocess is NOT invalidation: it re-derives rows under a new
  parser, exactly once, and keeps the archive.

### measure — every transition emits on the events bus

- Stage transitions emit events: `knowledge.enqueued` (work producer),
  `knowledge.landed` (worker completion), `knowledge.curate`,
  `knowledge.propose`, `knowledge.dispose`, `knowledge.reprocess`,
  `knowledge.graveyard` — scope `knowledge` on governor.db `events`.
- `consult kb stats` ranks what recall actually used (hits +
  last_hit_at).
- knowledge-api rides servicemon `/status` + `/metrics` (no token
  dimension — omitted honestly, never served as fake zeros).
- Hub roll: `GET /api/knowledge-ingest` shows landed counts per origin;
  W1217's sink adds provenance-counted aggregation (W1213).
- Decay sweeps report checked/proposed/refreshed/stale — the store's
  health is the disposition RATE, not the row count.

## The contract clauses

1. One lifecycle, no private paths. Every knowledge write enters through
   a capture face and passes propose gates on its way to a candidate row;
   no producer writes knowledge rows directly.
2. Canonical ownership is machine-local. governor.db + knowledge.db on
   the machine that produced the evidence are THE record. The NAS sink is
   an aggregated replica + recall face; it never arbitrates a local
   write, and a sink outage never blocks or rolls back a local write
   (W1220 fail-open law).
3. The wire never activates. Arrived rows land candidate; promotion is
   the human gate — there is no numeric activation shortcut (a human
   stamps 1.0; thresholds gate USE, never activation).
4. Provenance is mechanical, not narrative: setter-stamped confidence
   (W953), `source_ref` + `source_hash` (W100/W103), `origin_sid` +
   `origin_system`. Trust = hash re-check (verified/drift/unverified),
   read as permission-to-act, never as truth.
5. History is append-only. Invalidation is a state transition carrying a
   reason and (where applicable) the superseding link; graveyard rows are
   never deleted.
6. Recall is honest: dead rows never rank; unrated rows never meet a
   floor; anonymous callers get scrubbed output; every card carries
   provenance + the precedence preamble.
7. Injection is pointer-grade and surface-gated: the W953 surface matrix
   (lane-brief 0.6) applies to what a lane may ACT on, not what it may
   see. A brief injects pointers + the trigger rule; the lane verifies
   before acting on a lead.
8. Every stage is measured through the existing planes: the events bus
   for transitions, kb stats for recall utility, servicemon for faces,
   hub ingest counts for the roll. No new metrics plane.

## Face map — surface → stage → gate

| face (where it lives)                                                  | stage          | store/broker      | gate                        |
| ---------------------------------------------------------------------- | -------------- | ----------------- | --------------------------- |
| `coord knowledge-enqueue` (bin/coord.ts)                               | capture        | knowledge_queue   | broker row, no gate         |
| `knowledge-api /enqueue` (bin/knowledge-api.ts)                        | capture        | knowledge_queue   | hostGuard + write token     |
| `work done` completion (lib/work-knowledge.ts)                         | capture        | knowledge_queue   | kev-curation noise gate     |
| `coord fact set --if-version` (coord/facts.ts)                         | capture+consolidate | facts (CAS)  | CAS version check           |
| W1212 decant daily claims                                              | capture        | facts (CAS'd)     | CAS dedupe + conf stamp     |
| answered consult (coord/consult.ts)                                    | capture        | consult_kb        | answer existence; 0.6 stamp |
| `coord kb add` / harvest (coord/facts.ts, bin/harvest.ts)              | capture        | consult_kb        | direct seed; no gate        |
| knowledge-sync (bin/knowledge-sync.ts, W944)                           | capture (hub)  | candidate rows    | redactSecrets reject        |
| W1220 decant dual-write (upward roll)                                  | capture (sink) | sink replica      | CAS dedupe, fail-open       |
| knowledge-worker distill (bin/knowledge-worker.ts)                     | propose        | candidate rows    | secrets, near-dup, substitution |
| `coord knowledge-promote`                                              | validate       | knowledge.state   | HUMAN gate (W142)           |
| `coord knowledge-grade` (W836)                                         | validate       | grade fields       | evidence cite               |
| `coord knowledge-verify` / `trustOf`                                   | validate       | hash re-check     | mechanical                  |
| decay sweep `coord knowledge-propose` (W208)                           | consolidate    | knowledge_proposals | gate-free proposal        |
| `coord knowledge-curate` (W103)                                        | consolidate    | contributors note | gate-free flag              |
| `coord knowledge` search (coord.ts)                                    | recall         | 3 stores merged   | live states, floor, scrub   |
| `read_knowledge` MCP (bin/knowledge-mcp.ts)                            | recall+inject  | 3 stores merged   | cards + precedence          |
| `knowledge-api /search`                                                | recall         | 3 stores merged   | auth scrub + hostGuard      |
| W1218 `/knowledge/query` + `/knowledge/sql` (sink)                     | recall         | sink replica      | ro-SQL lint + bksk_ scopes  |
| W1225 lane-brief pre-flight + error-match                              | inject         | 3 stores merged   | lane-brief ≥0.6 surface     |
| `coord knowledge-retire` / `-graveyard`                                | invalidate     | state + reason    | reason required             |
| decay dispose (`knowledge-proposals` verb family)                      | invalidate     | state + reason    | HUMAN dispose               |
| servicemon `/metrics`, `kb stats`, events bus                          | measure        | events/metrics    | n/a                         |

## Consumer clauses

**W1218 (Buckle-verified query faces on the sink).** Both faces are
recall-stage faces over the REPLICA — read-only, never promote, never
write. Contract obligations: SELECT/WITH-only lint, LIMIT enforced and
capped, allowlisted fact tables only, SQLite `mode=ro`; bksk_-scoped keys
(knowledge:read / knowledge:query) verified via buckle
/v1/admin/keys/verify; x-headers identify the face (W1081); responses
carry provenance (trust markers + precedence) and the freshness
contract: the sink reflects the last successful roll, so a response says
"the world as the sink saw it at <ts>", never "now". Under 2s for
corpus-scale queries. Writes refused 4xx; unkeyed 401.

**W1220 (decant dual-write).** The daily run keeps LOCAL facts primary
and pushes the day's CAS'd claim roll UPWARD — child→sink only, never a
pull. Fail-open: sink outage logs and retries next daily run; the local
run's exit code is the LOCAL result only. Idempotent (CAS dedupe: same-day
rerun pushes zero new rows). Provenance rides verbatim (CAS key, version,
confidence stamp, origin). Retraction crosses as a tombstone event
(W1213.3 monotonic idempotent replay) — a delete on the origin MUST NOT
leave a zombie on the sink.

**W1225 (lane-brief injection).** The pre-flight line injects a recall
POINTER (read_knowledge / `coord fact get lesson.*`), not distilled
prose; error-match retrieval rides the same faces as any recall. The
lane-brief surface threshold (0.6) gates what the lane acts on; the
precedence clause renders in the brief so knowledge cannot override the
mission.

## Stage ↔ code index

- capture: knowledge-ports.ts `enqueueKnowledge`, work-knowledge.ts
  `queueCompletionKnowledge`, coord/facts.ts (fact set, kb add),
  coord/consult.ts (kb record), knowledge-sync.ts
- propose: knowledge-ports.ts (SqliteKnowledgeStore + parseDistill),
  bin/knowledge-worker.ts
- validate: lib/confidence.ts (W953 doctrine + CONFIDENCE_THRESHOLDS),
  trustOf in lib/knowledge.ts, coord/consult-trust.ts
- consolidate: knowledge-curate.ts (decay planner), knowledge-ports.ts
  (curate / proposeDecay / disposeProposal), substitution + near-dup in
  lib/knowledge.ts
- recall: knowledgeSearch + proseCards in lib/knowledge.ts
- inject: bin/knowledge-mcp.ts, bin/knowledge-api.ts /search,
  hooks/rules/fleet-knowledge.md
- invalidate: retire / graveyard / disposeProposal in knowledge-ports.ts,
  coord/facts.ts `fact rm`, W1213.3 tombstone semantics
- measure: lib/servicemon.ts, `coord kb stats`, governor.db events
  (scope knowledge), GET /api/knowledge-ingest

## Out of scope here (owned elsewhere)

- CrewAI/Dosu source-level research and licensing: W1124.18.4 (pending);
  the lineage line above cites the DESIGN borrow only.
- Sink compose + deployment: W1217; Merkle anti-entropy Phase 2: W1214.
- Hub auth scoping details: W1141 scoping + W1218 itself.
