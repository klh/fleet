# Knowledge lifecycle

The one contract every knowledge face obeys. Design lineage: staged-memory
lifecycles where memory writes pass through named stages, never ad-hoc,
plus provenance discipline where every claim carries where it came from
and a mechanical verification path. The deltas this contract keeps:
canonical ownership stays machine-local, and evidence gates replace truth
claims. No new framework, no new database — every stage maps onto faces
that already exist.

## Stores (exactly four)

| store                                              | holds                                                          | mutability                                                     |
| -------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| facts store                                        | control-plane state facts + content-addressed knowledge claims | mutable slot per key (CAS `--if-version`), latest-per-key wins |
| consult KB                                         | answered consults (problem → solution), kb seeds, harvest rows | append-only                                                    |
| knowledge.db `knowledge` / `_queue` / `_proposals` | distilled-claims ledger + durable broker                       | rows append-only; only state transitions mutate                |
| hub sink                                           | aggregated replica of both knowledge classes, keyed by origin  | replica — never authoritative                                  |

Session archives (decant's `decant.db`) are machine-local session
EVIDENCE — an input to capture, never itself a knowledge store. Their
content never crosses a machine boundary.

## The eight stages

`capture → propose → validate → consolidate → recall → inject → invalidate → measure`

Every face maps to ONE primary stage. No face writes past a stage's gate,
and a stage with no gate is named as gate-free (recency decay proposals
are gate-free PROPOSALS — a human still disposes them).

### capture — raw evidence enters a durable broker

Entry is always a durable, inspectable broker row — never a direct
knowledge-row write from a producer. Producers enqueue payloads with
declared `source_ref`s; the declared FILE is hashed at enqueue time — the
producer had repo access, the distiller never does. Completed work
receipts ride the same queue through a noise gate; content-addressed
claims land via CAS so restatements version instead of colliding. The
spoke→hub sync lands verified facts as CANDIDATE rows.

### propose — distill payload into candidate claims

The ingest worker runs the only distill path: a single-model pass through
the gated LLM boundary → canon clamps (topic ≤80, fact ≤400, confidence
0..1) → mechanical redaction (a private-key block rejects the whole
candidate) → near-duplicate gate (older row kept, skip noted) →
substitution contract (never store what one doc already teaches —
pointer-ize to `source_ref` + residue, or reject) → rows land
`state='candidate'`.

The distiller extracts; it never judges truth. `supersedes_id` is honored
only when the source text DECLARES the correction. The distill prompt is
config-over-code (`KNOWLEDGE_PROMPT_FILE`); its sha256 is the parser
version recorded against reprocess checkpoints.

### validate — activation and grading are evidence-gated

- Promote is the activation gate: a human promote action is the ONLY
  transition candidate→active. A wire (knowledge-sync) can never activate
  a row.
- Confidence doctrine grades every quality-bearing row: policy-trust bands
  (machine-raw → human-reviewed), stamp = {value, setter, ts, evidence,
  prior}, append-only confidence history, sha256-chained (tamper-evident).
  0.8 requires an independent reviewer (different model family), 0.9
  diverse checks, 1.0 human. Below the candidate threshold (0.6) a row is
  never auto-trusted.
- Grading stamps audit provenance (rating, evidence, researched_at) on a
  row.
- `trustOf` / verify: the mechanical trust check — re-hash the
  `source_ref` file and compare `source_hash`: `verified` / `drift` /
  `unverified`. Trust is permission-to-act, not truth.
- Consult answers carry version-scoped consult trust.

### consolidate — dedupe, correct, pointer-ize, decay

- Substitution contract at ingest; curation flags single-file-derivable
  rows for human review (flagging is not freshness — contributor notes
  append without an `updated_at` bump).
- Near-dup: the dedupe check keeps the older row; the skipped candidate
  rides a proposal a human disposes.
- Corrections create a NEW row via `supersedes_id`; `duplicate_of` marks
  merged twins. History stays walkable.
- Decay sweep: the planner scores rows (exponential half-life, un-reviewed
  rows decay 2×) → open `knowledge_proposals` → a human disposes (approve
  retires, dismiss starts a cooldown). The engine never retires anything
  by itself.

### recall — one search implementation, ranked and gated

One search implementation across the three local stores (knowledge →
facts → consult KB), consumed by the CLI, the MCP face, and the HTTP face
alike.

- bm25 rank + age penalty + origin-kind prior; live states only (retired
  and buried rows NEVER rank); `minConfidence` floor — an unrated row
  cannot demonstrate it clears a floor, so it is excluded, honestly.
- 1-hop pointer-graph expansion: neighbors joined by SHARED PROVENANCE
  (same source_ref, or domain+area), never text similarity.
- Every rendered card carries: state, confidence band glyph + value (or
  "unrated"), age, mechanical hash trust, 1-hop/via marker, and the
  precedence preamble — knowledge is context, never a constraint on the
  objective.
- Anonymous-call hygiene: refs/hashes are scrubbed from unauthenticated
  output; scope filters exclude the untaggable aux stores (facts carry no
  scope tags — private intel can never surface in a scoped search).

### inject — pointer-grade, precedence-first

- The MCP tool renders prose cards only, never a JSON blob to a model.
- `POST /search` — the same cards plus JSON hits for programmatic
  consumers.
- Injection value rides FILE-LEVEL pointers, not restated facts.
- A surface matrix gates USE, not display: board/search 0, brief
  injection 0.6, consult 0.8, benchmark 0.8, policy 1.0.

### invalidate — state change with a reason, never a delete

- Retire: live → retired with the walkable superseding link.
- Graveyard: integrity-flagged or rejected rows are BURIED (state +
  `graveyard_reason` on the row), append-only, excluded from ranking and
  curation scans forever.
- Decay disposal (approve → retire, dismiss → cooldown) is a human act.
- Tombstones on claims are monotonic and idempotent on replay.
- Key deletion applies only to session-scoped keys and control-plane
  corrections that never carried knowledge-plane weight — never to
  consult KB or knowledge rows.

### measure — every transition is observable

- Stage transitions emit on the events bus.
- Recall utility is measured (hits + last_hit_at), so the plane knows what
  recall actually used.
- The sink serves `/status` + `/metrics` (no token dimension — omitted
  honestly, never served as fake zeros).
- Hub aggregation reports landed counts per origin; decay sweeps report
  checked/proposed/refreshed/stale — the store's health is the
  disposition RATE, not the row count.

## The contract clauses

1. One lifecycle, no private paths. Every knowledge write enters through
   a capture face and passes propose gates on its queue→candidate path;
   no producer writes knowledge rows directly.
2. Canonical ownership is machine-local. The origin machine's stores are
   THE record. The sink is an aggregated replica + recall face; it never
   arbitrates a local write, and a sink outage never blocks or rolls back
   a local write (the fail-open law).
3. The wire never activates. Arrived rows land candidate; promotion is
   the human gate — there is no numeric activation shortcut (a human
   stamps 1.0; thresholds gate USE, never activation).
4. Provenance is mechanical, not narrative: setter-stamped confidence,
   `source_ref` + `source_hash`, origin ids. Trust = hash re-check
   (verified/drift/unverified), read as permission-to-act, never as truth.
5. History is append-only. Invalidation is a state transition carrying a
   reason and (where applicable) the superseding link; buried rows are
   never deleted.
6. Recall is honest: dead rows never rank; unrated rows never meet a
   floor; anonymous callers get scrubbed output; every card carries
   provenance + the precedence preamble.
7. Injection is pointer-grade and surface-gated: thresholds gate what a
   consumer may ACT on, not what it may see. Briefs inject pointers, not
   distilled prose; consumers verify before acting on a lead.
8. Every stage is measured through the existing planes: the events bus
   for transitions, recall stats for utility, `/status`+`/metrics` for
   faces, hub counts for the roll. No new metrics plane.

## Face map — surface → stage → gate

| face (where it lives)                 | stage         | store/broker        | gate                            |
| ------------------------------------- | ------------- | ------------------- | ------------------------------- |
| enqueue CLI / `POST /enqueue`         | capture       | knowledge_queue     | broker row, no gate             |
| completed-work receipts               | capture       | knowledge_queue     | noise gate                      |
| CAS'd claim writes                    | capture       | facts (CAS)         | CAS version check               |
| answered consult                      | capture       | consult KB          | answer existence                |
| knowledge-sync (spoke→hub)            | capture (hub) | candidate rows      | redaction reject                |
| ingest worker distill                 | propose       | candidate rows      | secrets, near-dup, substitution |
| human promote                         | validate      | knowledge.state     | HUMAN gate                      |
| grading                               | validate      | grade fields        | evidence cite                   |
| `trustOf` / verify                    | validate      | hash re-check       | mechanical                      |
| decay sweep                           | consolidate   | knowledge_proposals | gate-free proposal              |
| curation flagging                     | consolidate   | contributors note   | gate-free flag                  |
| search (any face)                     | recall        | 3 stores merged     | live states, floor, scrub       |
| MCP `read_knowledge`                  | recall+inject | 3 stores merged     | cards + precedence              |
| `/knowledge/query` + `/knowledge/sql` | recall        | sink replica        | ro-SQL lint + scopes            |
| retire / graveyard                    | invalidate    | state + reason      | reason required                 |
| decay disposal                        | invalidate    | state + reason      | HUMAN dispose                   |
| `/metrics`, recall stats, events bus  | measure       | events/metrics      | n/a                             |
