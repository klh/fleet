# Faces

Every HTTP route the sink serves (`bin/knowledge-api.ts`), plus the MCP
face. Auth classes: **anonymous** (host-guard only), **write token** (the
per-install `x-klh-write-token` header), **keyed** (buckle-verified
`bksk_` bearer key with a face scope).

| Route               | Method     | Auth                           | Scope                     | Payload                                                                     |
| ------------------- | ---------- | ------------------------------ | ------------------------- | --------------------------------------------------------------------------- |
| `/search`           | POST       | anonymous (token unlocks refs) | —                         | `{query, limit?, domain?, area?, origin_kind?, origin_system?}`             |
| `/enqueue`          | POST       | write token                    | —                         | `{source, payload, domain?, area?, code_origin?, origin_sid?, source_ref?}` |
| `/curate`           | POST       | write token                    | —                         | `{repo?, by?}`                                                              |
| `/promote`          | POST       | write token                    | —                         | `{id, by}` — names its human actor                                          |
| `/retire`           | POST       | write token                    | —                         | `{id, superseded_by?}`                                                      |
| `/note`             | POST       | write token                    | —                         | `{id, sid, what}`                                                           |
| `/verify/<id>`      | GET        | anonymous = ids/topics only    | —                         | —                                                                           |
| `/roll`             | GET / POST | roll key header or write token | —                         | claims batch `{claims, machine?}`                                           |
| `/graph`            | POST       | roll key header or write token | —                         | `{graph}` — spoke graph delta                                               |
| `/knowledge/query`  | POST       | bksk_ key                      | `buckle:knowledge:QUERY_` | `{question, limit?}`                                                        |
| `/knowledge/sql`    | POST       | bksk_ key                      | `buckle:knowledge:READ_`  | `{sql, params?, limit?}`                                                    |
| `/v1/consult`       | POST       | anonymous                      | —                         | `{question, as?, priority?}`                                                |
| `/ae/root`          | GET        | peer token                     | —                         | —                                                                           |
| `/ae/shard?index=N` | GET        | peer token                     | —                         | —                                                                           |
| `/ae/leaves`        | POST       | peer token                     | —                         | shard diff request                                                          |
| `/ae/merge`         | POST       | peer token                     | —                         | diff rows                                                                   |
| `/status`           | GET        | anonymous                      | —                         | —                                                                           |
| `/metrics`          | GET        | anonymous                      | —                         | —                                                                           |

The keyed faces answer 401 unkeyed, refuse mis-scoped keys, and stamp
every answer with an `x-klh-face` identity header. The query faces run
over a SQLite `mode=ro` connection behind a SELECT/WITH-only lint with
LIMIT enforced and capped (appended when missing, refused past the max)
and an allowlisted table set (`knowledge`, `knowledge_claims`,
`knowledge_fts`).

## Examples

Anonymous scrubbed recall:

```bash
curl -s http://127.0.0.1:7802/search \
  -X POST -H 'content-type: application/json' \
  -d '{"query":"launchd plist wiring","limit":5}'
```

Natural-language query (needs a QUERY_-scoped key):

```bash
curl -s http://127.0.0.1:7802/knowledge/query \
  -X POST -H 'content-type: application/json' \
  -H "authorization: Bearer $KNOWLEDGE_KEY" \
  -d '{"question":"which launchd label supervises the swarm?"}'
```

Direct parameterized SQL (needs a READ_-scoped key):

```bash
curl -s http://127.0.0.1:7802/knowledge/sql \
  -X POST -H 'content-type: application/json' \
  -H "authorization: Bearer $KNOWLEDGE_KEY" \
  -d '{"sql":"SELECT topic, fact FROM knowledge WHERE state = ? LIMIT 10","params":["active"]}'
```

Health and metrics:

```bash
curl -s http://127.0.0.1:7802/status
curl -s http://127.0.0.1:7802/metrics
```

Anti-entropy pull (one-shot, client side — the peer must serve the
`/ae/*` faces and share the token):

```bash
bun run bin/knowledge-api.ts --ae-pull https://peer.example.local \
  --ae-token-file /path/to/peer-token
```

## The MCP face

`bin/knowledge-mcp.ts` is a stdio MCP server exposing ONE tool:

- **`read_knowledge`** — `{query, limit?, domain?, area?, origin_kind?,
origin_system?}` → prose cards with trust markers (state, confidence
  band, age, hash verification, 1-hop pointer expansion) plus a precedence
  preamble: knowledge is context, never a constraint on the objective.

Read-only by design — the tool cannot write, promote, or retire. Wire it
into any MCP client:

```json
{
  "mcpServers": {
    "fleet-knowledge": {
      "command": "bun",
      "args": ["/path/to/fleet-knowledge/bin/knowledge-mcp.ts"]
    }
  }
}
```
