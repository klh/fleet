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
| install write token | WRITE_ROUTES + /ae/* + operator /roll     | writeToken()    |
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
- distill lease fencing → fk-local lease file or stays with the fleet
  trigger (whichever W2779.2 lands; record the pick here when it does).
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
