# bench/w1219 — text-to-SQL over the sink: benchmark + pin

W1219 (owner directive 2026-10-23, sink W1217): pick the /knowledge/query
translator — NL → ro-SQL — for the knowledge sink schema. Candidates = the
brief's three legs: (a) a sqlcoder-class local model on the NAS Ollama
host, (b) the swarm extract specialist, (c) one small cloud fallback.

## Protocol

- **Schema under test is the REAL sink schema**, built by the real
  `openKnowledgeDb()` path (`replica.ts` heals a fresh sink to the healthy
  DDL: knowledge/knowledge_claims/knowledge_proposals/knowledge_queue/FTS5
  + triggers + W836/W1226 columns), then seeded with a fixed-epoch replica
  of the W1213 claim namespace (multi-version claims, tombstones, provenance
  arrays, proposals, queue row). Not a made-up schema — the same DDL the
  sink face serves.
- **12 questions** (8 EN / 4 DA), each with an executable gold SQL verified
  against the seed (`questions.ts`). Every gold runs green before any
  candidate is measured (`runner.ts` `goldMap`).
- **One prompt for all candidates** (the sqlcoder task shape,
  `prompt.ts`), temperature 0, a UUID cache-buster first line so a
  completion cache can't fake latency.
- **Exec-match scoring** (Spider convention): a candidate scores when its
  SQL executes read-only AND returns gold-equal results — value-only,
  order-insensitive (`kit.ts` `rowsMatch`); column aliases are free. The
  ro-lint is the W1218 consumer contract (SELECT/WITH-only, no mutation
  words, single statement).
- **Latency p50/p95** over 12 timed attempts after one untimed warmup
  (`percentile`, nearest-rank).

## Candidates

| Candidate | Where | Wire |
| --- | --- | --- |
| sqlcoder:latest (7B Q4_0) | NAS Ollama :11434, CPU (`size_vram=0`) | `/api/generate` |
| qwen3-4b (mlx-community/Qwen3-4B-Instruct-2507-4bit) | swarm extract :8902 | `/v1/chat/completions` |
| glm-5.3-flash | cloud via buckle :4101 (minted bksk\_ key) | `/v1/messages` |

## Results (2026-10-24, 12 questions, temp 0)

| Candidate | exec | match | p50 | p95 |
| --- | --- | --- | --- | --- |
| sqlcoder@nas-ollama | 0% | 0% | 120003 ms | 120004 ms |
| **qwen3-4b@swarm-extract** | **100%** | **75%** | **299 ms** | **676 ms** |
| glm-5.3-flash@cloud (re-run, budget 2048) | 92% | 75% | 3348 ms | 60017 ms |

- **sqlcoder leg**: every attempt hit the 120 s bench timeout — NAS CPU
  inference of a 7B on the ~500-token task prompt cannot serve a live
  face. Not close.
- **Cloud leg measurement note (honest)**: the first run carried
  `max_tokens: 512` — glm-5.3-flash is a thinking model and spent the
  budget on thinking blocks, scoring 0% exec on the BUDGET, not the
  model ("anthropic-wire: no text", raw rows kept in
  `results/run-*.json`). After fixing the candidate (budget 2048 + join
  all text blocks) the leg was re-run in isolation
  (`results/run-cloud-rerun.json`); the table row is the re-run. The
  512-budget rows are an invalid measurement and are not counted.
- **Face contract (W1218)**: the consumer requires p95 ≤ 2 s. Only the
  swarm leg passes.

## Verdict + pin

**qwen3-4b on the swarm extract tier (:8902) wins outright**: sole
best-match-rate row (75%, tied with cloud but 11× faster p50, 100% exec,
and the only row inside the W1218 p95 ≤ 2 s face contract). By the
decision rule (within 10 points of best match-rate → fastest p50 wins)
the winner is **qwen3-4b@swarm-extract**; pinned as the `sql` upstream
group in `~/.claude/local-llm/upstreams.json` (conf-over-code):

```json
"sql": [
  {
    "url": "http://127.0.0.1:8902",
    "dialect": "openai",
    "adapter": "openai-compat",
    "model": "mlx-community/Qwen3-4B-Instruct-2507-4bit"
  }
]
```

The group rides the /knowledge/query face (W1218) as its ro-SQL
translator; the entry rewrites `model: "sql"` to the wire id the
:8902 specialist serves.

Known miss modes (recorded, both top rows at 75%): state-filter nuance
(Q06 read `candidate` instead of active), provenance field choice (Q07
read `claim_hash` instead of `evidence_id`), and — cloud only — one
lint-trip (mutation word inside a JSON expression) and one 60 s
upstream-retry wall (Q12).

## Reproduce

    bun packages/suspenders/bench/w1219/bin.ts        # all three legs
    bun packages/suspenders/bench/w1219/e2e.ts        # /knowledge/query e2e (needs the pinned sql group + fresh spoke)
    bun test packages/suspenders/bench/w1219/kit.test.ts

Raw rows: `results/run-2026-10-24T20:02:52.359Z.json` (full 3-leg run) +
`results/run-cloud-rerun.json` (post-budget-fix cloud leg).
