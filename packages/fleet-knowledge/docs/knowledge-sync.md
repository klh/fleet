# Knowledge sync — spoke→hub

The sync layer pushes each machine's knowledge to every connected hub,
policy-gated. What crosses the machine boundary is decided by CLASS, not
by row inspection: sync-by-default = aggregate METRICS only; default-DENY
= content. The sync layer is structurally incapable of shipping content
wholesale — there is no knob that re-enables it, and the session-archive
transcript surfaces have no invocation path in the sync code.

## Input surface — the session archive, never the database

The sync reads the vendored token-accounting toolkit's headless export
ONLY (`sync -q`, then `stats --by day|tool|model --format json
--no-sync`); per-session grain is opt-in (`policy.metricsSessions`). It
never parses the unencrypted session db directly. Local session ids cross
only as opaque sha256-derived 16-hex correlation ids; the projector copies
allowlisted metric fields (tokens/cost/context/durations) — transcript
text and local paths have NO code path into any payload.

## Policy config (machine-level, 0600, config-over-code)

`~/.config/klh/knowledge-sync.json`, mode must be exactly `0600`, ≤32 KiB.
The file IS the opt-in: no file = the sync is disabled. Origin-only URLs
(http only for loopback), ≤8 targets, per-target `writeTokenFile`
(absolute path, 0600, single-line token). `decantBin` names the vendored
toolkit's binary (absolute or PATH-resolvable).

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
    "facts": true,
    "claims": true
  },
  "decantBin": "/opt/homebrew/bin/decant"
}
```

Policy keys are booleans over the existing classes — unknown keys are
refused; the policy can only narrow/widen what already exists, never
invent a content class. Defaults: metrics on, session grain off, facts
on, claims on.

## Facts — verified-only crossing, candidate on arrival

Only `lesson.*` and `finding.*` fact rows cross, AFTER local
verification: any secret-pattern hit (the redaction rule engine, REJECT
posture) rejects the fact outright (boundary posture — stricter than
local ingest's redact-in-place), value ≤2000 chars, ≤50 facts per pass,
version-delta against the machine-local cursor
(`~/.claude-insights/knowledge-sync-state.json`,
`SUSPENDERS_KNOWLEDGE_SYNC_STATE` relocates it). The cursor stamps only
when EVERY target accepted the pass — partial passes re-send; the hub is idempotent (dupe topics skip; local
rows are never displaced).

## Hub side — the ingest face

Rides the host perimeter (allowlist + write token), 64 KiB cap, strict
per-dim validation:

- facts → knowledge rows, ALWAYS `state='candidate'` (the unverified
  trust marker), origin recorded per hub. The human promote gate governs
  activation; the wire can never activate a row.
- metrics → `sync_metrics` upserts keyed (origin_hub, dim, dim_key) —
  idempotent; day/tool/model/session dimensions, re-sent snapshots
  replace.
- `GET` on the ingest face — landed counts summary.

## Upward claim roll (content-addressed, credential-free transport)

Machines push their claim-class facts UP as a content-addressed roll.
Identity is the CAS key: sha256(evidenceId + NUL + claim + NUL + scope +
NUL + tenant when machine-scoped) — the same evidence+claim from any two
machines hashes identically, so the aggregate dedupes public content, not
by sender. Scope and (for machine-scope rows) tenant are IMMUTABLE key
dimensions: a foreign assertion — public or private — lands as its own
row and can never merge into (or widen) another tenant's private row; the
fleet plane stays the cross-machine aggregation.

- Collect: reads facts rows in the claim namespace (JSON
  `{claim, confidence?, tombstone?}`; plain text degrades to claim text),
  redaction with a REJECT posture (any hit skips the row, cursor never
  advances), version-delta against the sync cursor, 50 entries per pass.
  Rides only when a target is configured with `rollUrl` + `rollKeyFile`
  (policy `claims: true` default) — and the two are configured TOGETHER
  (the validator refuses one without the other).
- Transport (credential-free): `POST {rollUrl}/roll` with the scoped TTL
  key header `x-klh-roll-key`. The key is minted PER MACHINE on the hub
  (`bun run bin/knowledge-api.ts --mint-roll-key <machine> [--ttl-hours
N]` prints it once; only its sha256 is stored, 0600 keys file,
  `SUSPENDERS_ROLL_KEYS_FILE` relocates). Provenance resolves FROM the
  key — the payload carries no machine identity. The install write token
  stays a valid OPERATOR push path (machine then rides `body.machine`).
- Ack contract: a 2xx status alone is not acceptance — the claims cursor
  advances only on an explicit, validated positive ack matched to the
  batch (`ok:true` + counters accounting for at most the sent set;
  the idempotent tombstone re-push counts nothing, so exact-sum would
  wedge the cursor). Rejections delivered as HTTP 200 `{ok:false}`,
  malformed bodies, or counter overshoot retain the cursor; the hub side
  is idempotent, so the retry re-sends without dupes.
- Aggregate: lands in `knowledge_claims` under ONE `BEGIN IMMEDIATE` per
  roll. Same hash → provenance merge (counts stay per-machine; re-push =
  dupe). Different claim, same evidence → a NEW VERSION (MAX(version)+1 —
  restatement versions, never overwrites). A tombstone entry (same hash,
  `tombstone: true`) flips the row without deleting it; a newer assertion
  revives (last-timestamp-wins interim; merkle anti-entropy replaces this
  with a deterministic diff). Confidence = MAX asserted.
- Read: `GET /roll` — the aggregated view: confidence-ranked, per-machine
  provenance counts, tombstoned rows hidden by default. Anonymous callers
  get nothing; a roll key reads its own machine's claims plus the shared
  plane; the write token is the operator full view.
- Daily dual-write: the daily distiller rides a post-pass that rolls the
  same claims upward after its LOCAL writes land — local primary +
  fail-open (an outage logs in the roll result and retries next daily
  run; the daily's exit stays the LOCAL result), idempotent (the shared
  cursor stamps on full ack — whoever acks first wins, so the periodic
  sync and the daily never double-push), retraction crosses as a
  tombstone (no sink zombie).

## Operations

- Daemon cadence: the heartbeat fires the sync task on its own cadence;
  a manual pass is `bun run bin/knowledge-sync.ts [--json]` — exit 1 on
  config error or failed target.
- Trust/verify: the hub's ingest-face GET shows what landed; candidate
  rows surface in search only after promote.
