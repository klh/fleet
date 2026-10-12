# Project identity stage 2 — writer and namespace inventory

Stage-2 deliverable of the [cross-hub identity migration](cross-hub-project-identity.md)
(work item W459.2). Audit date: 7 October 2026. Source baseline: `0eb96b6`
(packages/suspenders/). No database keys were changed by this audit alone —
the code changes it ships are listed in §6 and ride the seam in §7.

Scope: enumerate every governor.db open site, every SQL-RPC caller, and every
consumer of the sessions / facts (incl. lane capsules) / events / cursors /
claims / locks tables; namespace the execution-ID families; classify the
intentionally-global facts explicitly. Stage 1 (W459.1) owns the
resolved-project interface; stage 3/4 own enrollment and the graph rekey. This
inventory is the source-location + presence map those stages migrate against.

## 1. Store open surface

Three sanctioned entry points in `hooks/lib/govdb.ts`:
`openGovernorDb()` (:388, raw SQLite handle), `openStore()` (:1156, the
binding chain env `GOVERNOR_STORE_URL` → `${REG}/store.url` → in-process) and
`openKnowledgeDb()` (:986, the knowledge.db file). `openMemoryStore()` (:1210)
serves work.ts's read-fallback and tests.

Every other `new Database(` site, classified:

| Site                                             | Class           | Notes                                                                                                           |
| :----------------------------------------------- | :-------------- | :-------------------------------------------------------------------------------------------------------------- |
| `hooks/bin/claim.ts:52`                          | BYPASS          | opens governor.db directly; ignores `GOVERNOR_STORE_URL` — cannot ride a remote authority                       |
| `hooks/gates/governor.ts:109,345`                | BYPASS          | same (files gate + bash gate lease/lock writes)                                                                 |
| `hooks/gates/files.ts:263`                       | BYPASS          | same                                                                                                            |
| `hooks/gates/bash.ts:311`                        | BYPASS          | same                                                                                                            |
| `hooks/bin/monitor.ts:18`                        | BYPASS          | reads + liveness writes, local file only                                                                        |
| `hooks/bin/quota-sweep.ts:23`                    | BYPASS          | same (transcript liveness requires local files)                                                                 |
| `hooks/bin/session-policy.ts:11`                 | BYPASS          | same                                                                                                            |
| `hooks/bin/consult-relay.ts:6`                   | BYPASS          | consult outbox writer                                                                                           |
| `hooks/bin/harvest.ts:43`                        | BYPASS          | local transcript harvest, local facts cursors                                                                   |
| `hooks/bin/worktree.ts:71,90`                    | BYPASS          | worktree registry writes                                                                                        |
| `hooks/bin/activity-harvest.ts:779`              | BYPASS          | transcript harvest → activity_rollup                                                                            |
| `hooks/bin/aid-harvest.ts:184`                   | BYPASS          | aid rollup flusher                                                                                              |
| `hooks/bin/metrics-alert.ts:183`                 | BYPASS          | read-only scanner                                                                                               |
| `hooks/bin/console-repo-law.ts:70`               | BYPASS          | console check                                                                                                   |
| `hooks/lib/decomposition.ts:78`                  | BYPASS          | optional `db` injection; defaults to local file                                                                 |
| `hooks/lib/lane-completion.ts:28`                | BYPASS          | capsule checkpoint read at completion                                                                           |
| `hooks/bin/federation-pull.ts:29`                | BYPASS          | pulls into the local store                                                                                      |
| `hooks/bin/store-server.ts:66,69`                | AUTHORITY       | the RPC authority itself: main connection + the tagged-tx connection                                            |
| `hooks/lib/federation-report.ts:277`             | READ-BYPASS     | readonly governor.db open for self-report evidence                                                              |
| `scripts/lib/copilot-meter.ts:105`               | SEPARATE FILE   | readonly Copilot usage DB (its own store, not governor.db)                                                      |
| `scripts/lib/resource-actuator.ts:82`            | SEPARATE FILE   | `actions.db` fence ledger — executor-local by design (0600, same shape as governor locks)                       |
| `hooks/lib/usage-rebuild.ts:20,26,32,33`         | SEPARATE FILE   | usage backup/report DBs                                                                                         |
| `hooks/lib/usage-migration.ts:37,38`             | SEPARATE FILE   | same                                                                                                            |
| `hooks/lib/usage-provenance.ts:22`               | SEPARATE FILE   | `:memory:` scratch                                                                                              |
| `hooks/bin/knowledge-resweep.ts:283,284`         | SEPARATE FILE   | direct knowledge.db opens (bypasses `openKnowledgeDb` pragmas — reads only)                                     |
| `hooks/lib/knowledge-ports.ts:817,854`           | AUTHORITY (kb)  | the knowledge port                                                                                              |
| `hooks/lib/settle.ts:81,99,100`                  | AUTHORITY       | knowledge settle: kb + governor pair                                                                            |
| `hooks/bin/db-backup.ts:44,49,81,84`             | TOOLING         | readonly open + `integrity_check` of both files                                                                 |
| `test/helpers/board-fixture.ts:164`              | TEST            | fake-HOME fixture                                                                                               |
| `deploy/runtime-info.ts:55`                      | TEST            | `:memory:` digest scratch                                                                                       |

BYPASS class = a writer that cannot be pointed at a shared authority without a
code change (stage 3/4 enrollment must convert these or prove local-only).
READ-BYPASS class is acceptable during migration: evidence reads stay local.

## 2. SQL-RPC surface

- `hooks/bin/store-server.ts` — POST `/rpc` (:343) and the WS `message()`
  channel (:365) execute arbitrary statements through the same validated path
  (:194). Validation = body shape + `knowledgeSqlViolation` (:170) only. There
  is **no project predicate** on any statement — the RPC is a trusted
  transport, not a tenant boundary (parent doc hazard, unchanged).
- WS `/subscribe` (:263) filters by recipient sid / scope-prefix / kinds
  (:136-141); scope is the caller's own string, not an authorized project.
- `hooks/lib/govdb.ts:1049` `HttpGovernorStore` — the client half. Callers
  riding it (via `openStore()`): `hooks/bin/work.ts:285` (lazy, per-command),
  `hooks/coord/shared.ts:52`, `hooks/board/context.ts:46`, `advise.ts:74`,
  `auth.ts:62,99,111`, `fleet-loop.ts:287,613,666,900`, `fleet-tracker.ts:52`,
  `usage-harvest.ts:353`, `usage-seed.ts:123`, `work-cr.ts:65`,
  `lib/work-cr.ts:367` (tests), `lib/dead-claim-recovery.ts:197`,
  `session-end.ts:27`, `session-start.ts:139`, `scripts/supervise.ts:146`,
  `scripts/lib/launch-fencing.ts:31,401`, `scripts/lib/copilot-meter.ts:183`,
  `sim/dr-rehearsal.ts:48,125`.

## 3. Table consumer matrix

Writers first; readers are representative (grep anchors, not exhaustive).

| Table                 | Writers                                                                                                                                       | Readers (representative)                                                                                          |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| sessions              | `session-start.ts:125` (upsert, PK sid), `coord/fleet.ts:136` (bootstrap lanes), `lib/usage-rebuild.ts:47` (synthetic rows)                    | sweepStaleSessions `govdb.ts:1325,1341`, gc `coord/facts.ts:319`, quota-sweep, consult routing, board lanes, settle |
| cursors               | `coord/bus.ts:222,292,425,645` (per-sid event position)                                                                                       | bus.ts poll/ack, board `lanes.ts:62`, `data.ts:475`, session-start `:298`, gc `coord/facts.ts:322`                 |
| facts                 | `coord/facts.ts:39` (fact set), `:82` (capsule), govdb tokenUsage cache `:282`, fleet snapshot `:451`, board exec `:40`, work-completion `:253` | session-start lesson scan `:386`, coord/shared kb `:161`, board data `:625,652`, monitor `:226`, fleet `:215,391`  |
| events                | `coord/bus.ts:65,113` (emit/broadcast), store-server broadcast insert `:86`, consult relay receiver                                             | poll/wait `bus.ts:187,269`, workTiming/tokenUsage `govdb.ts:96,183`, board decisions sync, metrics                  |
| claims                | `claim.ts:52` (direct), governor gate `governor.ts:109`, dead-claim-recovery                                                                    | coord fleet, work take, monitor                                                                                    |
| locks                 | files/bash gates `governor.ts`, `files.ts:263`, `bash.ts:311` (per-file leases)                                                                | lease-release `coord/facts.ts:106`, gc `:339`, monitor arbitration                                                 |
| work_items/deps/seq   | `work.ts` (lazy store), board actions `routes-actions.ts`                                                                                      | work read verbs, mirror fallback `work.ts:477`, board cards                                                        |
| consults / consult_kb | `coord/consult.ts:143` (+reply paths)                                                                                                          | kb lookup `coord/shared.ts`, stats `coord/facts.ts:160`                                                            |
| decisions             | board-owned DDL `board/context.ts:86`                                                                                                          | board lanes/data/routes, sweepStaleSessions `govdb.ts:1314`                                                        |
| deltas                | row triggers on 13 tables (`govdb.ts:693-832`)                                                                                                 | `coord diff` (fleet.ts:530), gc prune `pruneDeltas`                                                                |
| work_recovery_attempts, work_completion_records, lane_launch_* | `work.ts` recovery/completion, `dispatch-next.ts:648` intents, `lib/launch-fencing.ts` leases/usage | rekey covers them (`coord/fleet.ts:746+`)                                                                          |

## 4. Execution-ID namespaces

Lane identity is minted by `hooks/lib/laneslug.ts:10` (`laneSid`): W-labels map
injectively to `autow<digits-dashes>`, and since W460 new lanes append
`-p<sha256(common-dir)[0..16]>`. Legacy rows keep the bare slug — sids are
therefore **not** guaranteed globally unique until every live lane was minted
post-W460.

The execution namespace lives in the facts table under `lane.<sid>.*`:

| Key leaf            | Scope of meaning      | Writers                                                                        | Readers                                                            | Presence evidence                    |
| :------------------ | :-------------------- | :----------------------------------------------------------------------------- | :----------------------------------------------------------------- | :----------------------------------- |
| `lane.<sid>.capsule` | continuation packet   | `coord/facts.ts:82` (capsule set), `lib/work-completion-record.ts:253`          | `coord/facts.ts:74`, `coord/bus.ts:478`, `lib/lane-completion.ts:30`, `lib/work-completion-record.ts:119`, `tracker/snapshot.ts:301`, `board/data.ts:460` | value JSON `ts` + `checkpoint` sha   |
| `lane.<sid>.state`  | pause/wait lifecycle  | `coord/bus.ts:500` (PAUSED), board exec, dispatch WAIT_\* stamps                 | `coord/fleet.ts:215,248,391`, `coord/bus.ts:367,493,527,576`, `board/data.ts:460`, `monitor.ts:226`, gc             | fact `ts` = last transition          |
| `lane.<sid>.launch-attempt` | dispatch fencing | `dispatch-next.ts:728`                                                          | `lib/launch-fencing.ts:100`                                        | value holds attempt budget           |
| `lane.<sid>.usage`  | per-lane usage marker | `copilot-meter.ts:263` (`usageFactKey`)                                         | copilot harvest                                                    | value holds harvest ts               |
| `lane.<sid>.executor` / `.model` / `.locality` | lane registry badges | `board/exec.ts:40` (`laneExecFacts`)                                     | `board/lanes.ts:496` (`laneModelOf`)                               | dispatch-time stamp                  |

Retention: gc deletes `facts WHERE key LIKE 'lane.%'` older than the window
(`coord/facts.ts:325`). Rekey (`coord project rekey`, `coord/fleet.ts:746+`)
migrates six project-scoped tables + decisions + launch/recovery/completion
tables + `events.$.project` but does **not** touch facts — lane facts and
other fact keys survive a rekey keyed to the old world (documented stage-4
gap; safe today because lane sids embed the project hash at mint time).

Sibling execution namespaces outside facts:

- cursors: PK `sid` — global per store, one per lane (no project column).
- claims: PK `(sid, scope)` — global per store.
- locks: PK `path` (absolute, canonicalized) — executor-local by design.
- sessions.worktree + hb: the presence fields (where the lane runs, when it
  was last alive); `sweepStaleSessions` + transcript mtime decide liveness.

## 5. Fact-family classification

Explicit registry, now code (`hooks/lib/exec-namespace.ts` `factScopeOf`):

| Family (prefix)                          | Scope     | Rationale                                                                    |
| :--------------------------------------- | :-------- | :--------------------------------------------------------------------------- |
| `lesson.*` (incl. `lesson.seen.*`)       | GLOBAL    | fleet knowledge deliberately crosses projects; `lesson.seen.*` are per-lane markers under the global ledger |
| `finding.*`                              | GLOBAL    | fleet intel (same settle plane)                                              |
| `fleet.*`                                | GLOBAL    | operator knobs (zombie thresholds, governance mode)                          |
| `zombie.*`                               | GLOBAL    | monitor/advise thresholds                                                    |
| `llm.budget.*`                           | GLOBAL    | belt-side budget warnings                                                    |
| `coordinator.sid`, `integration.head`    | GLOBAL    | one per store by definition                                                  |
| `usage.*` (`usage.harvestAt`, `usage.tp.*`) | GLOBAL | harvest markers; per-actor data lives in rollups, not keys                   |
| `harvest.cursor.*`, `harvest.seen.*`     | GLOBAL    | path-keyed (munged absolute path), cross-repo by design                      |
| `metrics.tokens.*`                       | PROJECT   | sanitized project embedded in key (`govdb.ts:230`)                           |
| `metrics.snapshot.*`                     | PROJECT   | project embedded in key since this stage (§6)                                |
| `lane.*`                                 | EXECUTION | sid-scoped; sid embeds project hash since W460                               |
| anything else                            | UNREGISTERED | surfaced for classification before a new family goes live                 |

## 6. Defects fixed by this stage

1. **`metrics.snapshot.<date>` collided across projects** (`coord/fleet.ts:451`
   pre-change): the key carried only the ISO date, the project only the value —
   two projects snapshotting the same day overwrote each other. The key now
   embeds the sanitized project (`metricsSnapshotKey`).
2. **`lane..capsule` blank-sid row** (`coord/facts.ts:74` pre-change): a
   capsule read/write without `--as` silently targeted the literal key
   `lane..capsule` — a shared garbage namespace row. `laneFact()` now refuses
   blank sids loudly.
3. **Capsules carried no source-location**: the capsule value now records
   `loc` (the minting worktree's realpath) automatically at `capsule set`,
   next to the existing `checkpoint`/`file` anchors — the resume path can see
   where the capsule was written without trusting the reader's cwd.
4. **Project sanitization was duplicated** (tokenUsage inline `replace()`):
   now one `sanitizeProjectKey()` shared by the metrics token cache and the
   snapshot keys.

`metrics.snapshot.*` keys written before this change are orphans (readers
only look up today's date); no migration needed.

## 7. The stage-2 seam

`hooks/lib/exec-namespace.ts` is the one derivation point:

- `laneFact(sid, leaf)` / `laneKey(sid, leaf)` — writer-enforcing / reader-safe
  construction of `lane.<sid>.<leaf>`; `laneSidLike(sid)` and
  `laneLeafLike(leaf)` for the LIKE scans (retention, liveness, rekey counts).
- `factScopeOf(key)` — the §5 classification.
- `metricsSnapshotKey(project, isoDate)` + `sanitizeProjectKey(project)`.
- `capsuleValue(extra)` — capsule JSON shape with `loc` injected.
- `execPresence(store, sid)` — the presence accessor (session row + lane
  state fact): where the execution runs, whether it is alive, its state.

All `lane.<sid>.*` writers and readers, plus the fleet snapshot writer, adopt
the seam. The wire shape of existing keys is unchanged — live rows stay
readable, and stage 1's resolved-project interface can later swap the
project-qualification inside the seam without touching call sites again.

## 8. Open gaps (stage 3/4 material)

- SQL-RPC has no tenant/project predicate (§2) — enrollment + authority work.
- BYPASS-class writers (§1) cannot ride a remote authority yet.
- `rekey` does not migrate facts (§4) — safe until facts gain non-embedded
  project qualification.
- Legacy bare-slug sids (pre-W460) remain non-unique across projects; the
  registry treats `autow*` slugs as display labels once lane IDs go opaque.
- `metrics.tokens.*` sanitization can still collide for project paths that
  differ only in non-`[A-Za-z0-9._-]` characters (single local-store risk,
  noted for the opaque-ID cutover).
