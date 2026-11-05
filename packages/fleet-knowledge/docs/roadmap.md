# Roadmap

Deferred items — named, not forgotten. Each line is scope that exists as
a design or a fleet-side implementation and has not landed here yet.

- **Kev curation trio + knowledge-votes** — community-signal curation
  (verdicts, votes, thresholds) imports the fleet `@klh/settings` package.
- **Distill cli/config/lease/production/runner** — the distill CLI kit
  and fencing (leases, production gating, runner) ride the fleet CLI kit;
  this repo carries the pipeline modules, not the operator CLI.
- **coord CLI faces** — the facts/knowledge CLI verbs stay in fleet by
  design (they are transport-adjacent); this repo holds the libs they
  call.
- **Consult delivery + WS transport** — durable consult records, ack
  bookkeeping, and WS push delivery ride the fleet store transport (see
  [consult-api.md](consult-api.md), "What stays in fleet").
- **knowledge.sql SELECT-only enforcement** — a parse-tree-level
  SELECT-only gate on the direct SQL face (the current token-level lint
  plus the `mode=ro` handle is the entire enforcement today). Stated
  plainly because it is a gap: see SECURITY.md.
- **Row caps on the keyed faces** — the sql face caps LIMIT, not rows at
  rest; per-key row caps are deferred.
- **Full test-corpus parity** — the fleet corpus has suites this repo's
  test/ does not yet mirror; parity is incremental, not big-bang.
- **Import migration of fleet consumers** — moving fleet's consumers onto
  this repo as a dependency (submodule form) is planned, not landed.
