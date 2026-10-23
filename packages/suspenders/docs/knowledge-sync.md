# Knowledge sync — spoke→hub (W944, enterprise policy posture)

The W779 heartbeat's `knowledge-sync` task pushes each dev machine's work
telemetry to every connected hub board, policy-gated. What crosses the
machine boundary is decided by CLASS, not by row inspection: sync-by-default
= aggregate METRICS only; default-DENY = content. The sync layer is
structurally incapable of shipping content wholesale — there is no knob that
re-enables it, and decant's transcript surfaces (`export`/`show`/`search`)
have no invocation path in the sync code.

## Input surface — decant, never the db

The sync reads decant's own headless export ONLY (`decant sync -q`, then
`stats --by day|tool|model --format json --no-sync`); per-session grain
(`ls --json`) is opt-in (`policy.metricsSessions`). Never parses the
unencrypted decant db directly. Local session ids cross only as opaque
sha256-derived 16-hex correlation ids; the projector copies allowlisted
metric fields (tokens/cost/context/durations) — decant's `title`
(transcript-derived text) and `project_path` (local paths) have NO code path
into any payload.

## Policy config (machine-level, 0600, config-over-code)

`~/.config/klh/knowledge-sync.json`, mode must be exactly `0600`, ≤32 KiB.
The file IS the opt-in: no file = the sync is disabled. Same discipline as
the W491 relay config: origin-only URLs (http only for loopback), ≤8
targets, per-target `writeTokenFile` (absolute path, 0600, single-line token
= the target board's write token, provisioned out-of-band).

```json
{
  "localHub": "<machine id>",
  "targets": [
    {
      "url": "https://<hub-host>",
      "hubId": "<hub-id>",
      "writeTokenFile": "/absolute/path/to/target-token-file"
    }
  ],
  "policy": {
    "metrics": true,
    "metricsSessions": false,
    "facts": true
  },
  "decantBin": "/opt/homebrew/bin/decant"
}
```

Policy keys are booleans over the two existing classes — unknown keys are
refused; the policy can only narrow/widen what already exists, never invent
a content class. Defaults: metrics on, session grain off, facts on.

## Facts — verified-only crossing, candidate on arrival

Only `lesson.*` and `finding.*` fact rows cross, AFTER local verification:
any secret-pattern hit (redactSecrets) REJECTS the fact outright (boundary
posture — stricter than local ingest's redact-in-place), value ≤2000 chars,
≤50 facts per pass, version-delta against the machine-local cursor
(`~/.claude-insights/knowledge-sync-state.json`,
SUSPENDERS_KNOWLEDGE_SYNC_STATE relocates it). The cursor stamps only when
EVERY target accepted the pass — partial passes re-send; the hub is
idempotent (dupe topics skip; local rows are never displaced).

## Hub side — POST /api/knowledge-ingest

Rides the W264 perimeter (host allowlist + x-klh-write-token for non-GET),
64 KiB cap, strict per-dim validation:

- facts → `kb.knowledge` rows, ALWAYS `state='candidate'` (the unverified
  trust marker), `source='knowledge-sync'`, `origin_kind='remote-fact'`,
  origin hub recorded in origin_system. The hub's W142 gate — human
  knowledge-promote — governs activation; the wire can never activate a row.
- metrics → `sync_metrics` upserts keyed (origin_hub, dim, dim_key) —
  idempotent; day/tool/model/session dimensions, re-sent snapshots replace.
- `GET /api/knowledge-ingest` — landed counts summary.

## Upward claim roll (W1213 — CAS aggregate on the hub)

Machines push their claim.* facts UP as a content-addressed roll. Identity
is the CAS key: sha256(evidenceId + NUL + claim) — the same evidence+claim
from any two machines hashes identically, so the aggregate dedupes by
content, not by sender.

- Collect (machine): `collectClaims` reads facts rows in the `claim.*`
  namespace (JSON `{claim, confidence?, tombstone?}`; plain text degrades
  to claim text), redactSecrets with a REJECT posture (any hit skips the
  row, cursor never advances), version-delta against the sync cursor
  (`state.claims`), 50 entries per pass. Rides only when a target is
  configured with `rollUrl` + `rollKeyFile` (policy `claims: true`
  default) — and the two are configured TOGETHER (the validator refuses
  one without the other).
- Transport (credential-free): POST `{rollUrl}/roll` with the scoped TTL
  key header `x-klh-roll-key`. The key is minted PER MACHINE on the hub:
  `bun hooks/bin/knowledge-api.ts --mint-roll-key <machine> [--ttl-hours N]`
  prints it once, only its sha256 is stored (0600 `~/.cache/claude-governor/roll-keys.json`,
  SUSPENDERS_ROLL_KEYS_FILE relocates). Provenance resolves FROM the key —
  the payload carries no machine identity. The install write token stays a
  valid OPERATOR push path (machine then rides `body.machine`).
- Aggregate (hub): `aggregateClaims` lands in `knowledge_claims`
  (knowledge.db, self-healing CREATE) under ONE BEGIN IMMEDIATE per roll.
  Same hash → provenance merge (counts stay per-machine; re-push = dupe).
  Different claim, same evidence → a NEW VERSION (MAX(version)+1 — the
  versioning guard: restatement versions, never overwrites). A tombstone
  entry (same hash, `tombstone: true`) flips the row without deleting it;
  a newer assertion revives (last-timestamp-wins interim; W1214 replaces
  this with anti-entropy). Confidence = MAX asserted.
- Read: GET `/roll` on the knowledge-api and GET `/api/knowledge-roll` on
  the board — confidence-ranked, per-machine provenance counts, tenants
  roll-up, tombstoned rows hidden by default.

## Operations

- Heartbeat task: `knowledge-sync` (W779 fleet-loop, 1800s cadence, nice 10,
  120s timeout). Manual pass: `bun ~/.claude/hooks/suspenders/bin/
  knowledge-sync.ts [--json]` — exit 1 on config error or failed target.
- Trust/verify: `GET /api/knowledge-ingest` shows what landed; the hub's
  candidate rows appear in `coord knowledge` search only after promote.
- Consumers (W943 cross-check): the metrics tables feed enterprise
  analytics; BLAM benchmark telemetry (#47343) reads the same ingest with a
  different consumer.
