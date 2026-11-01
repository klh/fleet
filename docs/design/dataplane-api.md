# W2319 — Fleet dataplane API: AIP-style uniform resource face over the work graph

Design note (2026-10-30). Source: Firetiger's dataplane conventions
(`coord fact get finding.firetiger-dataplane-api`, Google AIP), mapped onto
fleet's control plane. Every "today" claim cites a file:line verified in this
worktree. Deliverable is this doc + minted follow-up items; no code lands here.

## Why

Fleet's control-plane facts live in one place (governor.db) but behind N
one-off faces: the `work`/`coord` CLIs, the board's `/api/*` routes, the
knowledge sink, the report contract. Every new consumer (board panes, hub
tooling, external automation, the klh-remote tier) re-learns a bespoke surface.
A **single uniform resource API** — the AIP conventions Firetiger ships —
gives every consumer one addressable, filterable, paginated face over the same
producers, without adding a parallel state machine (W1131 law: one contract,
every view renders from it).

Non-goals for v0: replacing the CLIs (they stay the writer surface), exposing
secrets/config, multi-hub federation (W2321's territory), streaming/SSE.

## The wire: one shape for everything

Every method is an HTTP POST to `/{package}.{Service}/{Method}` with a JSON
body — no REST verbs, no per-resource URL grammar:

    POST /fleet.work.v1.WorkItems/List
    POST /fleet.work.v1.WorkItems/Get
    POST /fleet.coord.v1.Lanes/List

Rationale: one dispatch table, trivially extensible (custom methods like
`Lanes/Steer` or `WorkItems/Split` are just methods, not new URL shapes), and
it matches the uniform-AIP precedent already proven on the knowledge sink
faces (POST-only JSON bodies, `hooks/bin/knowledge-api.ts`).

Resource names follow AIP-122 `{collection}/{id}` with parent prefixes for
nesting:

| Resource        | Name                                          | Backing rows                    |
| --------------- | --------------------------------------------- | ------------------------------- |
| Work item       | `projects/{project}/workItems/{id}`           | `work_items` (project, id PK)   |
| Lane            | `lanes/{sid}`                                 | `sessions` (sid PK; fleet-wide) |
| Event           | `projects/{project}/events/{eventId}`         | `events` (id AUTOINCREMENT)     |
| Work dependency | `projects/{project}/workItems/{id}/deps/{on}` | `work_deps`                     |

The project prefix is not decoration: governor.db is multi-project
(`work_items.project`, `events.project` — `hooks/lib/govdb/govdb-open.ts:141`,
`:42`), and the shredded `events.project`/`events.work` columns plus the
`events_project_ts` / `events_work_id` indexes (`hooks/lib/govdb/events-shred.ts:29-30`)
are exactly the keyset a project-scoped List needs. Lanes are fleet-wide by
nature (`work lanes` already is), so their collection carries no project
parent; `project` is a filterable field, not part of the name.

## Standard methods per resource

### WorkItems — `fleet.work.v1.WorkItems`

- **List** — page_size (default 50, max 500) / page_token / next_page_token;
  AIP-160 `filter` over the scalar columns (`state`, `priority`, `owner_sid`,
  `tags`, `updated_at` — the `work_items` DDL at
  `hooks/lib/govdb/govdb-open.ts:141`, `tags` via the :186 migration);
  `order_by` = `field [asc|desc]`, default
  `updated_at desc`. Cursor = opaque base64 keyset on (order_by value, id),
  not OFFSET — the tuple encodes the active sort column's own row value
  (string columns as strings, W2513), NULL-aware; Lanes carries the same
  keyset over (launchedAt, sid) in memory.
- **Get** — by resource name; terminal items remain Get-able forever.
- **Create** — title + optional parent/priority/tags/description; maps 1:1 to
  the `work add` argument surface (`hooks/bin/work.ts` verb) — the dataplane
  calls the same lib function the CLI calls, never a second writer.
- **Update** — takes the item + `update_mask` (comma-separated dot-paths;
  omitted mask = all mutable fields, which for v0 is `title`, `description`,
  `priority`, `tags`). Maps to `work edit` (`hooks/lib/work/work-edit.ts`),
  which already emits `work.edited` with changed fields — the audit story is
  already there.
- **Delete (soft)** — fleet already has soft-delete vocabulary: the terminal
  states DONE/FAILED/CANCELLED/SUPERSEDED. Delete maps to the CANCELLED
  transition (the `work` CLI's cancel/release path), `delete_time` maps to the
  terminal event ts, and **`show_deleted` = include terminal states in List**
  (default List hides them — exactly what `work report`'s "recent done"
  section opts into). No new column, no new semantics.

### Lanes — `fleet.coord.v1.Lanes`

- **List/Get** — renders from the same liveness producer `work lanes` uses
  (transcript-alive tri-state); fields: sid, project, role, worktree, state,
  heartbeat age, claimed work item.
- **Custom: `Message`** — `coord message <sid>` semantics (correction to a
  live lane; delivery contract unchanged).
- **Custom: `Steer`** — `coord steer` semantics, including its gates (one per
  sid per hour, scrub ruleset, pause kill-switch). Custom methods reuse the
  existing verbs' own enforcement — the dataplane adds no policy of its own.

### Events — `fleet.coord.v1.Events`

- **List only** (append-only log): `filter` on `kind`, `work`, `source`;
  keyset pagination on `events.id` (the `events_work_id` index). This is the
  same shape the board drawer and monitor tail read today; exposing it removes
  the need for consumers to open governor.db at all (law: no raw sqlite3 on
  governor.db from outside).

## Auth: bksk_ keys, two access levels

Mirror Firetiger's two-level key auth on the existing buckle key machinery
(`packages/buckle/src/gov/scopes.ts:24-33` already carries the
`buckle:{area}:{READ_|WRITE_}` pattern):

- `buckle:dataplane:READ_` — List/Get on every collection + Events.
- `buckle:dataplane:WRITE_` — + Create/Update/Delete and custom methods.

Keys are minted through the buckle admin API like every other lane key
(secrets minted, never typed); revocation and audit ride the existing key
registry. No new auth path is introduced — the dataplane validates the same
`authorization: Bearer bksk_…` header the knowledge faces validate
(`hooks/bin/knowledge-api.ts` Bearer handling).

## Errors: problem+json with AIP vocabulary

Buckle already answers problem+json (`packages/buckle/src/error-response.ts`).
The dataplane maps AIP's canonical codes onto it, one typed vocabulary:

| AIP code            | HTTP | problem type                                                      |
| ------------------- | ---- | ----------------------------------------------------------------- |
| invalid_argument    | 400  | `urn:klh:problem:invalid-argument`                                |
| unauthenticated     | 401  | `urn:klh:problem:unauthenticated`                                 |
| permission_denied   | 403  | `urn:klh:problem:permission-denied`                               |
| not_found           | 404  | `urn:klh:problem:not-found`                                       |
| already_exists      | 409  | `urn:klh:problem:already-exists`                                  |
| failed_precondition | 409  | `urn:klh:problem:failed-precondition` (e.g. Steer on a dead lane) |
| internal            | 500  | `urn:klh:problem:internal`                                        |

Every response body carries `{type, title, detail, status}`; parse failures of
a request body are invalid_argument with the offending field named — schema
law (W1238.4): named zod `Schema` per method, safeParse, never hand-cast.

## Implementation shape

One service module, one dispatch table — no framework, matching the
knowledge-api precedent (a Bun HTTP server in `hooks/bin/`, health sidecar
beside it per the outside-process health law):

```
hooks/bin/dataplane-api.ts      — HTTP door: route POST /{pkg}.{Svc}/{M},
                                  auth, problem+json, NDJSON access log
hooks/lib/dataplane/
  methods.ts                    — the dispatch table: method name → handler
  work-items.ts                 — WorkItems methods (calls work-graph lib)
  lanes.ts                      — Lanes methods (calls lanes lib)
  events.ts                     — Events.List (keyset over the shred columns)
  filter.ts                     — AIP-160 subset parser → SQL WHERE
  cursor.ts                     — opaque keyset encode/decode
  schemas.ts                    — zod request/response shapes, one per method
```

Writers never duplicate: each method calls the same lib function the CLI verb
calls (`work-cr.ts` for item mutations, `work-edit.ts` for Update, the lanes
liveness module for List). The dataplane is a face, not a second control
plane — its mutations emit the same events the CLI emits, so board, monitor,
and report stay coherent with zero new reconciliation.

### Relationship to the W1131 report contract

`work report`'s versioned JSON (`ReportContract`, `schema_version: 1` —
`hooks/lib/work/work-report.ts:469`) stays the **aggregated supervisor
view**. The dataplane is the **resource-level face**. They are complementary,
not competing: the contract renders sections and totals (needs_you, spend,
model health); the dataplane addresses single resources with standard-method
semantics. A future `fleet.supervisor.v1.Reports/Get` could render FROM the
contract — same law, one producer.

### AIP-160 filter subset for v0

Scalars only, no cross-resource joins, no functions: `=`, `!=`, `<`, `>`,
`<=`, `>=`, `:` (contains, on TEXT via LIKE), `AND` / `OR` / `NOT` with
parentheses, dot-paths into the row's own JSON columns (e.g.
`payload.kind`). The parser emits parameterized SQL fragments — never string
interpolation of user input. Unknown field in a filter = invalid_argument
naming the field (fail loud, schema law). Deliberately NOT in v0: timestamp
functions, `*` wildcards, `IN` arrays — none of the board/report consumers
need them.

## Rollout

1. **v0 read-only** (READ_ scope only): WorkItems List/Get, Lanes List/Get,
   Events List. Zero mutation risk; validates auth, filter, pagination
   against real consumers (board drawer, supervisor tooling).
2. **v0.1 writes**: WorkItems Create/Update + soft-Delete (the CANCELLED
   transition) + Lanes Message/Steer custom methods — each riding the
   CLI-equivalent lib path, gated WRITE_ scope.
3. **Hub placement**: same compose pattern as the knowledge sink (dedicated
   service + health sidecar, hub profile entry in stack.json), loopback +
   `*.local` host guard (W264) like every other board face.

One placement decision, non-blocking for v0: whether the dataplane rides the
hub buckle front (like lanes do, `/w/<sid>` scoped keys) or gets its own hub
service port like the knowledge sink. The knowledge-sink pattern is the
better fit: the dataplane is a fleet control-plane face, not an LLM proxy, so
it should not share the LLM gateway's front door.

## What this buys

- **One consumer surface**: board panes, hub tooling, klh-remote, external
  automation all read/write the graph through the same resource names —
  no more per-consumer bespoke routes on the board.
- **Auditable writes**: every mutation emits the same work.* / coord.* events
  the CLIs emit; the Events collection IS the audit trail.
- **Zero new state**: no new tables, no new ledger, no reconciliation —
  governor.db stays the single writer-owned truth.
- **Key-level access control**: read-only consumers get READ_ keys that
  cannot mutate anything, enforced at the same layer Firetiger enforces it.

## Follow-up items (minted separately)

- `dataplane v0 read-only service` — hooks/bin/dataplane-api.ts + lib
  modules, WorkItems/Lanes/Events List+Get, READ_ scope, filter+cursor,
  co-situated e2e (serveStub from the test kit).
- `dataplane filter parser` — AIP-160 subset → parameterized SQL, own module
  - exhaustive e2e (the riskiest pure function; land before the service).
- `dataplane writes` — Create/Update/Delete + Message/Steer, WRITE_ scope,
  each method riding the CLI-equivalent lib path with event parity tests.
- `buckle:dataplane scopes` — add the two scopes to the scope registry and
  admin mint surface.
- `hub deploy profile` — stack.json service + health sidecar, W264 host
  guard, both hubs.
