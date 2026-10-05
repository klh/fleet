# Fleet: enterprise deployment gaps and practical optimizations

Research date: **5 October 2026**. Repository snapshot: `87e6218`.

This document combines the [monorepo review](docs/monorepo-review-2026-10-05.md),
fresh source inspection, and online research from primary documentation. It is
the requested research and recommendation list; implementation and ownership
remain in the work graph. No recommendations below have been implemented here.

## What the review found

The architecture is coherent, but consolidation moved source ahead of the
installation, deployment and automation contracts that consume it.

| Priority | Finding                                                | Evidence                                                                                           | Required result                                                                        |
| :------- | :----------------------------------------------------- | :------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| P1       | Clean harness installation omits BLAM                  | `packages/suspenders/install.sh`; board `prompt-transform.ts` and `orch.ts` import BLAM relatively | Installed board modules load in an isolated home without any old checkout              |
| P1       | No root GitHub Actions workflow                        | Workflows exist under package `.github/` directories                                               | Root CI runs package tests, cross-package checks and installed-artifact checks         |
| P1       | Hub deployment assumes legacy repositories and layouts | `packages/suspenders/deploy/hub-compose.yaml`, `hubctl.ts`                                         | A pinned fleet checkout/artifact boots with correct `packages/` paths and dependencies |
| P2       | Workspace and release contracts are incomplete         | No root lockfile; local/speedy lack manifests; root and package versions differ                    | Reproducible dependency installation and explicit stack/package version semantics      |
| P2       | Umbrella installer clones legacy sources               | `packages/speedy/bin/install-fleet.ts`                                                             | All phases consume the same fleet revision                                             |
| P2       | Board implementation still conflicts with its Lit law  | `packages/suspenders/hooks/board-html/core.ts`, `tasks.ts` use `innerHTML`                         | Component migration validated for draft, selection and focus retention                 |

The installed BLAM import failure was reproduced during the preceding review;
120 focused source tests passed then. This research rechecked the relevant
installer/import code, workflow locations, deployment origins and legacy
installer acquisition paths; it did not rerun that complete test sequence.

The local-LLM extraction has landed. It is now a real package, not a placeholder.
Subsequent belt and buckle commits also delegate condensing to BLAM, making the
cross-package distribution contract more important.

GitHub explicitly requires workflow files in the repository's `.github/workflows`
directory. Moving nested YAML is only part of the fix: adjust working directories,
dependency setup and paths too. [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

## What already exists

Do not rebuild these controls under new names:

- Gateway scopes, hashed virtual keys, expiration/revocation, team/key budget
  machinery and JWT hooks: `packages/buckle/src/gov/`.
- Retry-after handling, jitter and cooldowns: `packages/buckle/src/router.ts`
  and `cooldown.ts`. Client cancellation is threaded into upstream execution.
- Prometheus-style `/metrics` and structured service status: buckle and
  suspenders `servicemon.ts` modules.
- Independent network health sidecars: `packages/suspenders/deploy/healthcheck/`.
- Consistent governor snapshots, integrity checks and rotation:
  `packages/suspenders/hooks/bin/db-backup.ts`.
- SQLite WAL, busy timeout, a serialized RPC store and tagged transactions:
  suspenders `govdb.ts` and `store-server.ts`.
- Decision-answer idempotency tokens and coordination WebSocket subscriptions.

The enterprise question is whether these controls remain correct across tenants,
replicas, restarts, failures and upgrades. Source presence is not deployment proof.

## Additional concrete findings

### A. Verify the bundled SQLite WAL-reset patch before deployment

The installed Bun runtime returned **SQLite 3.51.0** from an in-memory query:

```sh
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(":memory:"); console.log(db.query("select sqlite_version() as version").get()); db.close();'
```

SQLite documents a rare WAL-reset race affecting versions through 3.51.2, fixed
in 3.51.3 and later, with specified older backports. Fleet uses WAL with multiple
connections/processes, so patch verification is relevant. The version string
alone does **not** prove Bun lacks a vendor backport; no corruption was reproduced.
[SQLite WAL-reset advisory](https://sqlite.org/wal.html#walresetbug).

**Action:** establish a supported Bun/container runtime whose embedded SQLite fix
is verified by version or upstream backport evidence. Check the actual SQLite
library inside every release artifact, not only the host `sqlite3` executable.
Make runtime/SQLite version reporting part of deployment diagnostics and CI.

### B. Knowledge backup is weaker than governor backup

`db-backup.ts` uses `VACUUM INTO` for governor.db, but knowledge.db follows a
checkpoint with separate file copies of the DB and possible WAL. Writers can
resume between those copies; checkpointing is not a lock spanning the snapshot.
The code logs checkpoint `busy` rather than requiring successful completion.
Knowledge integrity failures also only log an error, after which the run can
still write `last-backup.txt`.

**Action:** use a consistent SQLite snapshot for knowledge too; publish successful
backup metadata only after all required snapshots pass checks. SQLite describes
`VACUUM INTO` as a consistent snapshot; verify completion and restoreability.
[SQLite VACUUM INTO](https://sqlite.org/lang_vacuum.html#vacuuminto),
[SQLite backup API](https://sqlite.org/backup.html).

Also sort `ksnaps` newest-first before choosing generation-slot entries. Unlike
the governor list, knowledge snapshots use `.find()` without timestamp sorting,
so retention does not reliably choose the newest snapshot in each slot.

**Acceptance:** concurrent-write backup test; restored database passes integrity
and application-invariant checks; failed knowledge snapshot fails the run;
rotation retains the newest timestamp per slot. These are source findings, not
reproduced production data loss.

### C. The gateway ledger has retry bounds, not a hard queue-capacity bound

`packages/buckle/src/ledger.ts` stores pending usage/audit entries in arrays.
`flushRows` triggers a flush; it does not cap admission. Failed writes requeue
entries; entries are eventually dropped after a configured retry count.

**Action:** set explicit maximum pending entries/bytes and age, with separate
durability policy for billing/security audit versus diagnostic telemetry.
Expose queue depth, oldest age, flush latency and dropped records. Critical audit
may need a durable spool or admission refusal; do not silently reinterpret the
current drop counter as durable audit evidence.

**Acceptance:** hold SQLite writes unavailable while applying sustained traffic;
memory remains bounded, overload responses are defined, and required audit events
are recoverable or requests are refused according to policy.

## Enterprise deployment gaps to close

The following are engineering recommendations. "Not established" means this
inspection did not find an end-to-end implementation or proof; it does not mean
every related feature is absent. The private fleet-remote checkout was not inspected.

### 1. Reproducible release, upgrade and rollback

**Current evidence:** loose base image tags (`oven/bun:1`, `alpine/git`), separate
repository pulls and no root lockfile. Stack pinning is already a stated law.

**Recommendation:** produce one release manifest containing fleet commit,
dependency lock digest, runtime/container digests, schema versions and artifact
checksums. Preserve the git-pulled-volume design if desired, but pull one verified
revision and prepare its dependencies reproducibly. Test upgrades from supported
prior schemas, migration failure, and rollback compatibility; code rollback alone
does not reverse database migrations.

Attestations can establish build provenance and be verified by CLI. GitHub plan
eligibility differs for public versus private repositories, so check it for
fleet-remote before adopting that service. [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

**Acceptance:** a clean machine reproduces the release; a failed upgrade retains
recoverable state; the documented rollback path is exercised. Add SBOM and
license-notice generation to the artifact pipeline after root CI works.

### 2. Explicit state ownership before horizontal scaling

**Current evidence:** SQLite files, process-local budgets/cooldowns, and a store
server accepting SQL RPC with one serialized connection. These are not a
demonstrated multi-writer cluster contract.

**Recommendation:** begin with one authoritative state owner per hub and local
storage, accessed over the API. Define ownership epochs/fencing for failover,
leader recovery, and how stale dispatchers are prevented from committing work.
Treat raw SQL RPC as a privileged internal interface, not a tenant-facing API.
Use a network database only if measured shared-write or HA requirements justify it.

SQLite WAL supports concurrent readers but a single writer, and requires callers
sharing the DB to be on the same host; do not scale by sharing its WAL files over
NFS/SMB. [SQLite WAL concurrency and deployment constraints](https://sqlite.org/wal.html).

**Acceptance:** kill the authority during claim/merge, resume the old process,
and prove there is no double claim, double merge or stale-state acceptance.

### 3. Tenant isolation and complete authorization coverage

**Current evidence:** key scopes, team fields, JWT hooks and private/hub domain
rules exist. A cross-tenant test matrix spanning graph, facts, subscriptions,
artifacts, caches, usage and administrative APIs was not established.

**Recommendation:** decide whether enterprise customers receive dedicated hubs
or share a hub. Bind organization/project context to verified identity; propagate
it into jobs and data access. Define operator, auditor and lane capabilities.
Test revoked membership and cross-tenant object IDs on every relevant surface.
Identity-provider group mapping and automated offboarding belong in the private
tier if that is its contract; SCIM is conditional on customer requirements.
[OWASP tenant isolation](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html),
[OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

**Acceptance:** tenant A cannot read, subscribe to, mutate, restore or export
tenant B's records, and membership revocation takes effect within a stated bound.

### 4. Replica-safe budgets and admission control

**Current evidence:** governance budget windows live in process memory with
periodic database flushing; key/team limits exist. Multiple gateways sharing a
team allowance would need a defined aggregate reservation protocol.

**Recommendation:** keep one budget authority initially or implement atomic
reservations shared across replicas. Reserve input and bounded output allowance,
then reconcile actual usage. Add limits for simultaneous generations, per-team
lanes, queue depth and GPU memory, with fair scheduling under contention.
Cross-tenant resource controls are part of isolation. [OWASP tenant resource controls](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html#5-api-asynchronous-work-resource-controls).

**Acceptance:** concurrent requests through two processes cannot multiply a
team's quota; a noisy tenant cannot exhaust all inference slots.

### 5. End-to-end deadlines and replay-safe side effects

**Current evidence:** retry/backoff and cancellation exist, and decision answers
have idempotency tokens. A global attempt/deadline budget across router, gateway,
provider and orchestration was not established.

**Recommendation:** set a total request deadline and attempt budget across the
whole chain. Deduplicate retried task creation, dispatch, credential minting and
merge requests with durable operation IDs and payload-hash conflict detection.
Do not automatically replay generation after partial streamed output.
[AWS retry limits](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_limit_retries.html),
[AWS idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

**Acceptance:** inject a lost response after a successful write; retries return
the original result rather than creating another lane/key/item. Provider failure
does not cause multiplicative retries or exceed the total deadline.

### 6. Service objectives, actionable alerts and correlated diagnostics

**Current evidence:** `/metrics`, route audits and health probes exist. A shipped
scrape/alert configuration, service-objective definitions and cross-service trace
context were not found in the inspected paths.

**Recommendation:** build on existing counters. Define objectives for control
API availability, dispatch delay, successful model service and recovery time.
Separate gateway overhead from inference latency, including time to first token.
Propagate trace context plus request/work/lane IDs through the chain; keep unique
IDs out of metric labels to bound cardinality. Export via a small collector.
[Google SRE monitoring](https://sre.google/workbook/monitoring/),
[Google SRE SLO alerts](https://sre.google/workbook/alerting-on-slos/),
[OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/).

**Acceptance:** a dropped audit batch, stuck dispatcher or sustained provider
failure produces a tested alert; an operator can follow one failed request across
services without searching unrelated logs. Start with actionable alerts, not a
dashboard for every available metric.

### 7. Restore drills and disaster-recovery coverage

**Current evidence:** governor/knowledge backup code and local rotation exist;
restore drills and a complete hub credential/policy/database backup inventory
were not established. Local snapshots do not cover machine loss.

**Recommendation:** define acceptable data-loss window (RPO) and restoration time
(RTO), inventory governor/knowledge/gateway/identity/config state, and keep
encrypted backups in a separate failure domain. Coordinate snapshot generation
across databases or reconcile their state on restore; separate snapshots do not
automatically represent one transactionally consistent system state.
[SQLite backup guidance](https://sqlite.org/backup.html).

**Acceptance:** restore into a clean hub, verify claims/dependencies and revoked
credentials, prevent duplicate dispatch, and measure recovery against the chosen
targets. Store encryption recovery material separately from the failed machine.

### 8. Deployment resource isolation and graceful draining

**Current evidence:** code volumes are mounted read-only and services restart,
but the hub template has no explicit CPU/memory/PID limits, capability drops,
non-root user selection or shutdown grace configuration.

**Recommendation:** add tested resource profiles, non-root execution where
compatible, capability restrictions, log rotation and a read-only root filesystem
with explicit writable state/tmp locations. Separate readiness from liveness.
Drain ingress, stop new dispatch, finish or checkpoint work, flush required
queues, then stop within the configured grace period.
[Docker Compose service controls](https://docs.docker.com/reference/compose-file/services/).

**Acceptance:** a service exceeding its memory budget cannot take down the hub;
a routine deployment does not sever every active stream or lose required writes.
Keep independent health sidecars; verify dependency/start ordering as well.

### 9. Audit retention, redaction and credential lifecycle

**Current evidence:** usage/admin audit machinery and revocable keys exist; the
route ledger deliberately permits eventual record dropping after flush failures.
Operational metrics are not automatically a durable enterprise audit trail.

**Recommendation:** classify critical admin/security events separately from
debug telemetry. Define retention/export/deletion rules, redact credentials and
prompt content by default, restrict audit access and protect exported evidence
against modification. Verify rotation/expiry for provider, bootstrap and lane
credentials, including emergency revocation and recovery.
[OWASP security logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).

**Acceptance:** key mint/revoke, policy changes and privilege changes remain
attributable after restart; secret canaries never appear in exported logs.

### 10. Capacity, failure and compatibility testing

**Current evidence:** many unit/integration suites, deterministic BLAM scenarios
and measured model benchmarks exist. A supported deployment capacity envelope
and full-stack failure qualification were not established by this review.

**Recommendation:** define target counts for active lanes, concurrent streams,
hubs, tenants and retained events. Exercise rising concurrency until saturation,
then provider failure, disk-full, locked DB, slow subscribers, restart and network
partition. Record p50/p95/p99, queue age, memory, WAL size and recovery correctness.
Verify each supported agent API dialect and runtime version with contract tests.
[Google SRE monitoring guidance](https://sre.google/workbook/monitoring/).

**Acceptance:** publish a measured supported envelope and degradation behavior;
passing unit tests is not the capacity claim. Use BLAM where its existing scenarios
match rather than inventing a second failure benchmark.

## Low-hanging optimizations

Effort labels are relative: **small** is localized, **medium** crosses services
or needs failure testing. No speedup percentage is claimed before measurement.

| Order | Change                                                                    | Effort                                        | Why it helps                                                                  | Acceptance / measurement                                                                          |
| :---- | :------------------------------------------------------------------------ | :-------------------------------------------- | :---------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| 1     | Verify/fix embedded SQLite patch level and pin supported runtime          | Small verification; upgrade validation varies | Removes avoidable WAL integrity exposure                                      | Artifact reports fixed SQLite or documented backport                                              |
| 2     | Package BLAM and add installed-module import smoke tests                  | Small-medium                                  | Catches source-versus-install failures immediately                            | Isolated install loads board and changed router/gateway modules                                   |
| 3     | Root CI with dependency-aware package paths and lock-keyed caching        | Small-medium                                  | Restores automation and avoids testing unrelated packages on every edit       | Shared BLAM changes trigger all consumers; cached and cold CI timings recorded                    |
| 4     | Consistent knowledge snapshot, fail the run on failure, sort rotation     | Small-medium                                  | Improves backup reliability without replacing storage                         | Concurrent-write restore and generation-selection tests                                           |
| 5     | Scrape current `/metrics` and alert on drops, failures, queue age         | Small-medium                                  | Uses existing instrumentation rather than adding another counter system       | Synthetic failures reach the operator with an actionable message                                  |
| 6     | Add ledger pending-entry/byte caps and bounded RPC admission              | Medium                                        | Prevents overload from becoming uncontrolled memory growth                    | Locked-DB/slow-client load leaves bounded memory and explicit overload responses                  |
| 7     | Test and configure long-generation / SSE idle timeouts                    | Small-medium                                  | Avoids connection resets during slow first-token or silent stream intervals   | Slow mock upstream and idle stream survive their configured deadlines                             |
| 8     | Prepare repeated audit INSERT/UPDATE statements in the ledger constructor | Small                                         | Makes the SQL path explicit and avoids repeated lookup overhead where present | Compare flush CPU and p95 latency; Bun may already cache queries, so retain only measured benefit |
| 9     | Coalesce board reads and deliver bounded event deltas                     | Medium                                        | Reduces repeated full-graph queries and reconnect traffic                     | Same view state with fewer queries/bytes; preserve cursor replay and drafts                       |
| 10    | Add measured indexes/keyset pagination to large event/audit views         | Small-medium                                  | Keeps long-lived hubs from degrading as history grows                         | Use EXPLAIN QUERY PLAN; compare large-history queries before/after; avoid speculative indexes     |
| 11    | Pin container digests and configure resource/log limits                   | Small-medium                                  | Makes deployment behavior reproducible and isolates resource spikes           | Reboot/deploy resolves the same artifact; logs and memory remain bounded                          |
| 12    | Measure model residency and generation concurrency under real lane load   | Medium                                        | Targets MLX memory pressure and tail latency rather than idle benchmark wins  | Compare cold/warm TTFT, quality, throughput and p95 at the actual lane concurrency                |

For item 7, Bun documents that idle timeout applies even to in-flight handlers
and quiet streams. The gateway already caps body size; tune long-lived stream
timeouts per request while retaining explicit total deadlines and cancellation.
The deployed Bun version must be tested rather than assuming today's docs exactly
match every installed runtime. [Bun server timeout documentation](https://bun.sh/docs/runtime/http/server#idletimeout).

For items 6 and 8, the inspected ledger has prepared usage upserts but constructs
audit statements in insert/update methods. The store's promise chain serializes
requests without an explicit queue-length cap in that module. These are concrete
places to measure; an absent cap in a module does not establish every upstream
admission limit is absent.

For item 9, WebSocket coordination already exists. Prefer reusing its event/cursor
contract over adding a separate bus. Do not cache authorization or tenant-sensitive
responses without including identity/domain and invalidation in the cache contract.

## Suggested sequence

1. **Integrity and repeatability:** SQLite patch verification, missing installed
   dependency, root CI, reliable backups.
2. **Deployment contract:** workspace, single pinned source/artifact, fresh boot,
   upgrade/rollback and credential recovery.
3. **Bounded operation:** queue/resource caps, shared-budget semantics, deadlines,
   readiness/draining, metric collection and useful alerts.
4. **Enterprise qualification:** tenant authorization matrix, restore/failover
   drills, audit exports and measured capacity envelope.
5. **Measured performance:** UI deltas, query/index work, ledger preparation and
   model-concurrency tuning. Keep improvements only when evidence supports them.

Start with a reproducible single-hub deployment and explicit state ownership.
Kubernetes, a new database, a new message broker or a larger model are conditional
choices; none substitutes for packaging, bounded queues or verified recovery.

## Evidence limits

This is source inspection plus online research, not a penetration test, load test
or compliance assessment. Production machine config, private fleet-remote,
off-machine backup destinations, actual alerts and live hub versions were not
inspected. Source findings are distinguished above from recommended checks and
prior reproductions. No production settings or runtime services were changed.
