# The fleet ↔ fleet-knowledge seam (W2779)

THE contract every W2779 child codes against. Owner rescope 2026-11-06:
fleet-knowledge (icomdev, BSL, public) owns the whole knowledge SUBSTRATE;
fleet keeps agent interfaces and triggers. Both sides build against THIS
document, not against code archaeology or chat history. A change to any
face, scope, or knob below lands as a change to THIS file in the same
commit.

Companion docs: `knowledge-lifecycle.md` (stage semantics stay),
`knowledge-sync.md` (spoke→hub transport stays). This file owns only the
W2779 boundary: what moves, what stays, and the wire contract between.

## Ownership split (the one table)

| concern                                                         | owner                     | W-item     |
| --------------------------------------------------------------- | ------------------------- | ---------- |
| knowledge.db store, migrations, paths                           | fk                        | W2779.2    |
| facts / consult_kb / veracity / rolls / merkle / anti-entropy   | fk                        | W2779.2    |
| distill storage + serving, decant-roll dual-write               | fk                        | W2779.2    |
| knowledge-sync ingest, scrub (secret-filter.ts)                 | fk                        | W2779.2    |
| knowledge-api host-guard + health probe sidecar                 | fk                        | W2779.2    |
| ONE consult interface (POST /api/consult + history)             | fk                        | W2779.4    |
| session-start/end hooks (thin clients)                          | fleet                     | W2779.3    |
| coord knowledge verbs as HTTP/CLI faces                         | fleet                     | W2779.3    |
| gates ask/stop knowledge triggers                               | fleet                     | W2779.3    |
| fleet-loop maintenance (sync/distill/consolidate forks)         | fleet                     | W2779.3    |
| harness mcpServers entry, MCP server                            | fk (serve) / fleet (wire) | W2779.2/.3 |
| knob registry rows (client env)                                 | fleet                     | stays      |
| belt/buckle HTTP clients                                        | fleet                     | W2779.3    |
| KEV typed-decision GATE logic                                   | fleet                     | stays      |
| peer-SID routing + interrupts                                   | fleet                     | stays      |
| governor.db operational state (sessions/work/claims/provenance) | fleet                     | stays      |

DRY targets across the boundary are W2779.1's list (precedence preamble,
SQL guardrails, scrub rule DATA — shared format, never shared code; the
BSL/public vs private boundary forbids code imports either way).

## Wire contract — faces fleet calls on fk

Base URL: `SUSPENDERS_KNOWLEDGE_SINK_URL` (origin only, no path). All
faces JSON. All reads fail-open in fleet callers: a sink miss/partition
must never break the local read it backs (the sink-client law).

Recall (existing, unchanged):

- `POST /search {query, limit?, domain?, area?, origin_kind?, origin_system?}`
  → `{query, preamble, cards, hits[]}` — anonymous callers get scrubbed
  hits (source_ref/source_hash/code_origin dropped); trust states stay.
- `POST /knowledge/query {question, limit?}` → `{rows, rowCount, sql,
elapsedMs}` — bksk_ key, scope `buckle:knowledge:QUERY_`.
- `POST /knowledge/sql {sql, params?, limit?}` → same shape — scope
  `buckle:knowledge:READ_`. SELECT/WITH-only lint, LIMIT cap, ro
  connection (fk's guardrails become the serving face, W2779.1 item 2).

Consult (W2779.4, new):

- `POST /api/consult {question, surface, context?, hop_budget?}` →
  `{answer, confidence, provenance, citations[]}` — cited answer riding
  fk's ask + plan + hops pipeline. bksk_ scope
  `buckle:knowledge:CONSULT_` for fleet callers; loopback anonymous
  stays for human UI.
- `GET /api/consults?surface=` and `GET /api/consult/<id>` — history.
- LANDED (fk branch `suspenders/W2779.4`, fk src/consult/): one pipeline
  — secret-filter ingress (withheld question = refusal, never reaches
  the LLM), retrieve+hops fused evidence labeled [Kn], the guarded plan
  leg as empty-evidence fallback, the answer leg under the claim
  contract (uncited lines dropped, deterministic confidence stamp —
  bands high ≥0.7 / medium ≥0.4, zero on abstention). Consults persist
  to the fk-local consults store (conf `consult.store` path, default
  `<db>-consults.db`; `FLEET_KNOWLEDGE_CONSULT_STORE` env overrides —
  fk-owned knob, not SUSPENDERS_*). Auth detail: a presented key MUST
  verify — a bad key never downgrades to anonymous (fail closed);
  absent verify conf (no buckle front) = keyed callers 503, loopback
  anonymous still served. Buckle-side CONSULT_ scope row landed in
  fleet (buckle src/gov/scopes.ts W2779.4; mint + verify e2e).

Curation / lifecycle (existing verbs, retargeted fleet-side in W2779.3):

- `POST /enqueue {source, payload, domain?, area?, code_origin?,
origin_sid?, source_ref?}` — install write token.
- `POST /curate {repo?, by?}` · `POST /promote {id, by}` ·
  `POST /retire {id, superseded_by?}` · `POST /note {id, sid, what}` —
  write token; promote names its human actor.
- `GET /verify[/<id>]` — anonymous gets id+topic only.

Session-settle face (W2779.3.1, additive):

- `POST /settle {sid, hub}` → `{queueMarked, rowsBackfilled}` — stamps
  hub_eligible for a session's knowledge_queue + knowledge rows on the
  sink copy; install write token (`SUSPENDERS_KNOWLEDGE_WRITE_TOKEN` or
  the 0600 file form `SUSPENDERS_KNOWLEDGE_WRITE_TOKEN_FILE`, both with
  registry rows in packages/settings). The domain read (sessions table)
  stays fleet-side — governor.db keeps operational state. Fail-open: a
  sink miss falls back to the fleet-local store stamping (compatibility
  law). The session-start lesson push needs NO new face — it rides the
  existing `/knowledge/sql` over `knowledge_facts` (bksk_ READ_ key).

Roll / graph / anti-entropy (machine-to-machine, unchanged):

- `POST /roll` (machine TTL roll key header or write token + body.machine)
  · `GET /roll` (roll key reads own machine + fleet plane; token = full)
- `POST /graph {graph, machine?}` — same auth as /roll.
- `GET /ae/root` · `GET /ae/shard?index=` · `POST /ae/leaves` ·
  `POST /ae/merge` — install write token (peer mirrors).

Auth model, one row per credential:

| credential          | faces                                     | minted          |
| ------------------- | ----------------------------------------- | --------------- |
| none (anonymous)    | /search, /verify, /api/consult (loopback) | —               |
| install write token | WRITE_ROUTES + /settle + /ae/* + operator /roll | writeToken() |
| machine roll key    | /roll, /graph                             | --mint-roll-key |
| bksk_ QUERY_/READ_  | /knowledge/query, /knowledge/sql          | buckle admin    |
| bksk_ CONSULT_      | /api/consult (fleet callers)              | buckle admin    |

## Knobs (names STAY fleet-side; fk never reads SUSPENDERS_* env)

`SUSPENDERS_KNOWLEDGE_SINK_URL` · `SUSPENDERS_KNOWLEDGE_KEY` ·
`SUSPENDERS_KNOWLEDGE_KEY_FILE` · `SUSPENDERS_KNOWLEDGE_SINK_TIMEOUT_MS` ·
`SUSPENDERS_KNOWLEDGE_SYNC_STATE` · `SUSPENDERS_KNOWLEDGE_VERIFY_URL` ·
`SUSPENDERS_KNOWLEDGE_VERIFY_TOKEN` ·
`SUSPENDERS_KNOWLEDGE_VERIFY_TIMEOUT_MS` ·
`SUSPENDERS_KNOWLEDGE_DISTILL` — registry rows in
packages/settings/src/settings.knob-registry.ts are the client contract;
fk owns its own conf (standalone conf-owned paths per the rescope edge
list). Fleet tests pin fk behavior through the seam only.

## Edge resolutions (from the owner rescope, pinned here)

- govdb path/open helpers → fk standalone conf-owned paths.
- scrub → fk `src/core/secret-filter.ts` (gitleaks + redaction already
  there); fleet keeps its gates but shares RULE DATA format, not code.
- `@klh/settings` (kev.ts) → fk conf/env; fk imports nothing from fleet.
- knowledge-api servicemon/host-guard/consult-oracle deps → fk-native
  host guard + health probe sidecar (owner law: outside-process health).
- distill lease fencing → LANDED fk-local: `src/knowledge/lib/distill/lease.ts`
  holds the single `distill_lease` row in the fk store, fenced by the
  ported process-birth identity (`support/process-birth.ts`); the fleet
  trigger never owns it.

## W2779.2 landed rulings (fk substrate, fk branch `suspenders/W2779.2`)

- **(a) Data migration**: one-shot tool `src/knowledge/bin/knowledge-migrate-fleet.ts`
  — `--gov <governor.db> --kb <knowledge.db> [--apply] [--force]`; dry-run
  default, ids preserved verbatim, sources opened read-only (fleet files
  untouched); rollback = drop/restore the fk store; cutover = the W2779.3
  conf flip. Re-apply refuses when target tables hold rows (opt-in --force).
- **(b) Store schema**: fk v1 fresh-file DDL (full fleet v10+ column shape)
  in `src/knowledge/lib/kbdb.ts`, self-healing guarded ALTERs on every
  open (the fleet openKnowledgeDb doctrine); file = conf `knowledge.db`
  (default `~/.local/share/fleet-knowledge/knowledge.db`), SEPARATE from
  the corpus index.sqlite. The fleet v6/v10 governor migration ladder
  stays fleet-side (history); fk never runs it.
- **(c) Serving shape**: `src/knowledge/bin/knowledge-api.ts` IS the
  fk-native sink server — it holds the ONE rw store handle; the fk web UI
  stays READONLY on the corpus index. Host guard (fk allowlist default
  fk.local + loopback) + servicemon /status+/metrics in-bin; the compose
  health probe sidecar polls /health (owner law: outside-process health).
- **(d) Curation verb faces** (additive, write-token gated):
  `POST /grade {id, rating?, evidence?, researched_at?, by?}` ·
  `POST /graveyard {id, reason, by?}` ·
  `GET /decay-proposals` + `POST /decay-proposals` (sweep) ·
  `POST /dispose {id, decision: approve|dismiss, by?, note?, superseded_by?}` ·
  `POST /consolidate {by?}` · `POST /reprocess {prompt_hash?, apply?}` ·
  `POST /review-drain {limit?}` — all ride the store methods verbatim
  (grade/graveyard/proposeDecay/disposeProposal/consolidate/
  reprocessCheck/drainKevReview).
- **(e) Inference transport**: every LLM/roll/consult leg reads fk conf
  (`FLEET_KNOWLEDGE_CONFIG` knowledge block: answerUrl/answerModel,
  kevUrl) — fk reads NO `SUSPENDERS_*` env; the ported knobs carry `FK_*`
  names (FK_KEV_URL, FK_SQL_LLM_*, FK_BUCKLE_URL/TOKEN, FK_MEMORY_*,
  FK_ROLL_KEYS_FILE, FLEET_KNOWLEDGE_* for the perimeter/conf).
- **(f) Kev boundary**: kev curation internals (suggest/drain/votes,
  typed-decision INPUT assembly) moved with the store; the
  typed-decision GATE (plan/ask triggers, hop budgets, the fleet
  kevTypedDecision in gates/ask.ts) STAYS fleet.
- Scrub port: fk owns its transport-scrub copy
  (`src/knowledge/support/scrub.ts`) — same rule DATA shape, no org-private
  rules; the fleet commit gate keeps its own copy (rule data shared as
  files, never code, per the BSL boundary).
- Tests: 19 suites (179 tests) moved as fk e2e against the moved modules
  (`bun test src/knowledge/`); fleet-history suites (v6/v10 split
  migration, gc CLI, settle CLI, w244 coord verb) and fleet-seam suites
  (coord CLI, board ingest, gates triggers, sink client) STAY fleet.
- Provenance stamps: computed fleet-side at trigger time, stored verbatim
  via the fk API — governor.db keeps the operational linkage only.

## Compatibility law

During the migration window (until W2779.3 lands), the fleet-local
knowledge-api faces and the fk faces are wire-compatible: a caller
pointed at either base URL gets the same shapes above. W2779.3's
retarget is then a conf flip (`knowledge.sink.url`), not a code change.
Face ADDITIONS are additive (new paths); face CHANGES or removals bump a
note here and ride a fleet broadcast (`coord emit BROADCAST --scope
suspenders`) in the same turn they land.
