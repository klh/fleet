# fleet-knowledge

One SQLite knowledge plane for agent fleets. Producers — agent sessions,
work receipts, the vendored decant session archive — land in a durable
queue and are distilled into candidate claims with provenance; a hub sink
API serves them to CLI, HTTP, and MCP consumers; spoke→hub sync replicates
per-machine facts under a deny-by-default class policy, and hub-to-hub
convergence rides merkle anti-entropy. Every row carries a trust marker
(state, confidence band, age, hash verification), and every answer states
how far it may be trusted. TypeScript on Bun; the generic, MIT-licensed
extraction of the fleet agent stack's knowledge plane.

## Architecture

One database, one ingest pipeline, and a set of faces over them —
producers, the plane, the consumers, and the remote sync pusher, mapped
end to end in [docs/architecture.md](docs/architecture.md).

## Quickstart

```bash
bun install
bun run typecheck
bun test ./test/
bun run serve          # the hub sink API on :7802 (127.0.0.1)
```

Other entry points: `bun run worker` (ingest drain loop), `bun run mcp`
(read-only stdio MCP server), `bun run bin/oracle.ts <verb>` (review /
bugs / analyze / panel), `bun run bin/knowledge-sync.ts [--json]`
(spoke→hub push pass).

## Stores and faces

Four durable stores in one SQLite database (WAL + FTS5), all written
through one store port (`src/sqlite-store.ts`):

| Store                 | Holds                                                              |
| --------------------- | ------------------------------------------------------------------ |
| `knowledge`           | append-only rows — topic, fact, state, provenance, trust           |
| `knowledge_claims`    | content-addressed cross-machine claims, versioned, tombstoneable   |
| `knowledge_queue`     | the durable broker — producers INSERT even when the worker is down |
| `knowledge_proposals` | decay/curation proposals — gate-free; disposal is a human act      |

The sink API (`bin/knowledge-api.ts`) serves the faces below — auth
classes, scopes, payloads, and curl examples in
[docs/faces.md](docs/faces.md):

| Face                  | Auth                     | What it does                                           |
| --------------------- | ------------------------ | ------------------------------------------------------ |
| `/search`             | anonymous                | scrubbed recall cards (no refs/hashes unauthenticated) |
| `/knowledge/query`    | `bksk_` key, QUERY scope | natural language → SQL via a pinned SQL LLM            |
| `/knowledge/sql`      | `bksk_` key, READ scope  | direct parameterized read-only SQL                     |
| `/roll`               | roll key or write token  | cross-machine claim roll + aggregate view              |
| `/ae/*`               | peer token               | merkle anti-entropy: root/shard/leaves/merge           |
| `/v1/consult`         | anonymous                | oracle-first knowledge-plane answering                 |
| `/verify/<id>`        | anonymous                | ids/topics only; the write token unlocks               |
| `/status`, `/metrics` | anonymous                | observability pair                                     |

Compose healthchecks hit a sidecar that polls `/status` and serves the
verdict on :7803 — a server cannot paint itself healthy.

## Sync and anti-entropy

Spoke→hub replication is deny-by-default by CLASS: aggregate metrics may
cross by policy; content crosses only after local verification and always
lands `candidate` — the wire can never activate a row. Claims ride a
content-addressed roll authenticated by per-machine TTL keys (sha256
stored, printed once). Hub-to-hub convergence descends a merkle tree over
the claims store — deterministic diff, not timestamp-wins.
[docs/knowledge-sync.md](docs/knowledge-sync.md)

## Decant — vendored token accounting

`decant/` vendors dosu-ai/decant v0.11.0 (Apache-2.0). The knowledge
layer consumes it as a subprocess CLI (`sync -q`, then
`stats --by day|tool|model --format json --no-sync`) plus read-only
SQLite; the archive stays machine-local and never crosses a machine
boundary. [docs/decant.md](docs/decant.md)

## Oracle and consult

`bin/oracle.ts` is the named review/escalation tool — one stateless
surface with a fixed prompt contract, two legs through one gated LLM
boundary ([docs/oracle.md](docs/oracle.md)). The consult API layer is the
pure state machine (interrupt vs btw delivery, budget windows) plus the
trust-tier rules that decide which knowledge rows may answer a consult
([docs/consult-api.md](docs/consult-api.md)).

## Configuration

Every env knob the code reads is documented in
[.env.example](.env.example), grouped by surface. Knobs keep the
historical `SUSPENDERS_` prefix for fleet compatibility — a fleet
install's existing environment keeps working unchanged. Prefer the 0600
`*_KEY_FILE` / `*_TOKEN_FILE` forms over raw env values.

## Roadmap

Deferred fleet-only surfaces are named, not forgotten:
[docs/roadmap.md](docs/roadmap.md) — the distill CLI kit
(config/lease/production/runner), the coord CLI faces, consult delivery
plus the WS transport, and full test-corpus parity.

## License

MIT — see [LICENSE](LICENSE). The vendored `decant/` toolkit ships under
Apache-2.0 with its own LICENSE and NOTICE in-tree; see [NOTICE](NOTICE).
