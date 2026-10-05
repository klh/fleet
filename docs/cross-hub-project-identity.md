# Cross-hub project identity: audit and migration design

Audit date: 5 October 2026. Source baseline: `c65a7ff`.

Fleet currently uses a local Git administration directory as both a work-graph
partition and a filesystem locator. That is useful inside one clone, but it is
not a shared enterprise project identity. Fixing this requires separating logical
identity, execution location, data authority and authorization. This document is
an inspected design proposal; no identity keys or live databases were changed.

## Confirmed behavior

`hooks/lib/govdb.ts:23` resolves `git rev-parse --git-common-dir` against the
working directory and canonicalizes it with `realpathSync`. Non-Git fallback is
the working directory's real path.

An isolated experiment imported the actual resolver into two synthetic clones
and a linked worktree. Both clones had identical origins and the same commit.
The temporary repositories were removed afterwards; no production DB was opened.

| Checkout                | Resolver result, with temporary prefix omitted |
| :---------------------- | :--------------------------------------------- |
| Alice's main clone      | `alice/.git`                                   |
| Alice's linked worktree | `alice/.git`                                   |
| Bob's independent clone | `bob/.git`                                     |

Worktree identity equality was true; clone identity equality was false. Origin
and revision equality were both true. This demonstrates the partition split
even before introducing separate hubs. Git documents linked worktrees as sharing
a repository while maintaining distinct worktree metadata.
[Git worktree documentation](https://git-scm.com/docs/git-worktree).

If Alice and Bob point to the same existing governor store, their different
project strings still select separate work graphs. If both have separate stores,
changing their strings to the same UUID alone does not combine the data or make
claims transactional across hubs. Both identity and authority must be resolved.

## Concrete migration hazards in current source

Paths below are relative to `packages/suspenders/`.

| Finding                                                 | Inspected anchors                                                                                                                                                 | Consequence                                                                                                                                                         |
| :------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared project key is a local directory                 | `hooks/lib/govdb.ts:23`; `hooks/bin/work.ts:261`                                                                                                                  | Same repository in separate clones gets different graph partitions                                                                                                  |
| Project keys are used as execution paths                | `hooks/board/orch.ts:171,211,299`; `hooks/board/routes-actions.ts:391,550`; `scripts/lanes.ts:15`; `hooks/lib/quota-sweep.ts:61`; `hooks/bin/work.ts` mirror path | An opaque project ID cannot safely replace the current string without separating path consumers                                                                     |
| Identity derivation is duplicated and inconsistent      | `hooks/bin/worktree.ts:34`; `hooks/bin/harvest.ts:53`; `hooks/coord/fleet.ts` metrics path resolver                                                               | Worktree CLI walks to a `.git` entry instead of resolving the common directory; harvest stores raw Git output, which can be relative, unlike the canonical resolver |
| Bootstrap and coordination can select different stores  | `hooks/session-start.ts:131` calls `openGovernorDb`; `hooks/coord/shared.ts:47` calls `openStore`; `hooks/bin/worktree.ts` and `harvest.ts` open the local DB     | Setting a remote store address does not by itself ensure all writers register or update the same authority                                                          |
| Lane ID depends only on the work label                  | `scripts/dispatch-next.ts:434`                                                                                                                                    | `W1` in two projects becomes `autow1`; removing dots also maps `W1.23` and `W12.3` to the same ID                                                                   |
| Several namespaces are global in a store                | `hooks/lib/govdb.ts` schemas for sessions, facts, cursors and locks; `hooks/coord/facts.ts`                                                                       | Session PK is `sid`; lane capsules and metadata use `lane.<sid>.*`; work-label collisions can overwrite or misattribute state                                       |
| Shared-store reads are not uniformly project-filtered   | `hooks/coord/shared.ts:73` KB query; `hooks/bin/store-server.ts` WS filtering                                                                                     | KB retrieval lacks a project predicate; subscription filtering uses recipient/scope/kind without an authorized tenant/project constraint                            |
| Store RPC is a trusted transport, not a tenant boundary | `hooks/bin/store-server.ts:232-273` and RPC execution                                                                                                             | Loopback plus optional shared token protects trusted access, but does not constrain arbitrary SQL to the caller's authorized project                                |
| Existing rekey handles rename, not graph unification    | `hooks/coord/fleet.ts:700-756`                                                                                                                                    | Rekey refuses a destination containing work; it cannot merge two clones' independent graphs or work-label collisions                                                |

The store findings describe inspected access/filtering behavior, not a claim of
a demonstrated attack or live data leak. Existing authentication issuance routes
do not themselves establish row-level authorization for the inspected SQL RPC.

The first two identity inconsistencies also merit standalone fixes before global
IDs: a linked worktree contains a `.git` file, so the worktree CLI's nearest-entry
algorithm can select the linked entry rather than the parent's common directory;
the harvester can write `.git` rather than the real absolute partition. These are
source findings, not end-to-end reproductions of those CLIs in this audit.

There is also a concrete rekey coverage gap: `hooks/board/context.ts:85` defines
`decisions.project`, but the rekey table list does not include `decisions`.
`hooks/board/lanes.ts:155` backfills only rows with missing metadata, so populated
legacy project fields are not automatically repaired by rewriting event payloads.
Include these records in the migration inventory. This omission is source-verified;
no existing graph or decision was rekeyed to reproduce it against live state.

## Recommended identity model

Use opaque IDs with explicit ownership and relationships. The registry assigns
the logical project; a local resolver binds a checkout to it after verification.

| Field                    | Meaning and lifetime                                                                            |
| :----------------------- | :---------------------------------------------------------------------------------------------- |
| `tenant_id`              | Corporate security namespace; required on shared authority requests                             |
| `project_id`             | Stable work/coordination domain, independent of paths, hosts and display names                  |
| `repository_id`          | Registered source repository; belongs to an explicit project mapping                            |
| `service_id`             | Stable service identity for policy and deployment evidence; not automatically a directory name  |
| `executor_id`            | Registered machine/agent runtime which can materialize checkouts and run tools                  |
| `checkout_id`            | One executor's local clone/bare checkout binding, with local common-dir and source repository   |
| `worktree_id`            | One checkout's concrete working tree, branch/revision and execution location                    |
| `lane_id`                | Global execution identity, independent of a work label or harness conversation                  |
| `attempt_id`             | One dispatch/retry attempt with lease and fencing identity                                      |
| `harness_session_id`     | Native Claude/Codex/etc. conversation identifier, qualified by harness/storage owner            |
| `authority_id` and epoch | Which control-plane authority may accept project mutations and which generation owns that right |

Hub identity is a placement/routing attribute, not the project's identity. Model
gateway location and source-code executor location may differ. A process PID is
meaningful only on its owning executor and for its recorded process lifetime;
another hub must not infer liveness by checking the same numeric PID locally.

One project may contain several repositories; a monorepo may contain several
services or explicitly separated project scopes. Begin with one project per
repository for current Fleet behavior, but record repository and scope separately.
Do not automatically join old subtree repositories to the monorepo: source
lineage and shared work-graph ownership are different decisions.

Each session gets a resolved context object rather than one overloaded string:

```text
tenant/project/repository IDs
authority binding + epoch
executor/checkout/worktree IDs
local checkout root + common Git directory + current working-tree root
source revision + relevant dirty-content evidence
```

Paths stay local to the executor unless explicitly needed in protected execution
metadata. Shared evidence uses repository ID, commit, relative path and content
digest. A global board dispatches to an executor's registered checkout; it never
tries to run a repository path from another machine on the board host.

## Resolve identity without trusting a copied string

Recommended managed-mode resolution:

1. Authenticate tenant, developer and executor independently of repository text.
2. Read a local binding or repository hint and resolve it against the authorized
   project registry. A hint supplies a candidate, not membership or credentials.
3. Verify source repository identity through the trusted enrollment process.
   Provider host plus repository API identifiers can be useful registry inputs;
   Fleet should keep its own ID and explicit mappings for mirrors and migrations.
4. Resolve authority independently of model-gateway selection; fetch allowed
   policy/starter scopes and the authority epoch.
5. Record a checkout binding. All consumers use this one resolution contract.

Git supports adding/removing remotes and changing their URLs. Therefore hashing
`origin` is unsuitable as the only durable identity: SSH/HTTPS spelling, multiple
remotes, transfers, mirrors and forks require explicit interpretation.
[Git remote documentation](https://git-scm.com/docs/git-remote).
GitHub's repository response includes API identifiers and fork/parent metadata
which a provider adapter can use, without treating a display URL as authority.
[GitHub repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository).

Avoid heuristic automatic merges based on equal names, URLs, commits or a UUID
copied into a fork. A repository hint may be committed if deliberately allowed,
but cannot grant access. For personal/unregistered projects, retain a clearly
local identity namespace. For managed projects, resolution failure must not
silently create a writable local graph masquerading as the enterprise project.
Cached authorized evidence can remain readable under the chosen offline policy.

Repository rename/move changes its locator, not its established Fleet ID. A new
fork receives separate repository identity and policy-approved work scope by
default. Sharing upstream lessons or starter artifacts can be authorized without
sharing claims, private assessments or developer conversations.

## Authority and isolation are required alongside identity

Initially assign one logical write authority per managed project. Many hubs may
execute lanes and serve starters; route work claims, decisions, session presence
and policy assessment mutations to the same project authority. Storage can later
be sharded by tenant/project while preserving that logical ownership.

Keep local and remote operation compatible through domain verbs, not by exposing
the current unrestricted SQL interface to enterprise clients. On the server,
derive actor and allowed project from authenticated credentials; enforce them on
work, session, consult, fact, subscription and artifact operations. A supplied
`project_id` is a selection key, never proof of authorization. Trusted internal
adapters can remain during migration behind the controlled boundary.

Use `(tenant_id, project_id, work_id)` or an equivalent opaque work identity for
shared work; preserve `W1` as a display label. Mint lane/attempt IDs independently.
Keep fact visibility explicit: tenant-wide approved lessons, project findings and
private lane state need distinct scopes. Prevent consult retrieval and WS feeds
from bypassing that visibility model. Local filesystem locks remain scoped to an
executor/worktree; cross-executor editing coordination uses repository-relative
scope plus branch/base context and the relevant task, not raw absolute paths.

Identical source files on different branches need not share an exclusive local
file lock. Shared logical work ownership prevents duplicate tasks, while branch
integration still needs its own review/merge coordination. A global project ID
does not eliminate merge conflicts.

Authority failover needs a durable epoch and fenced writes/claims. An isolated
old hub cannot continue accepting authoritative mutations after promotion of a
replacement. Read-only snapshots must identify authority, revision and age;
offline lanes may prepare patches but cannot silently obtain authoritative work
claims or approvals. Do not copy a live SQLite file between hubs and call that
multi-writer coordination.

The current `resolveHub()` flow selects an LLM gateway endpoint for dispatch.
That should remain distinct from project authority discovery. Prefer an explicit
runtime registry binding for the first implementation; do not add consensus or
peer-to-peer merging before one shared authority works.

## Migration plan with bounded rollout

1. **Separate semantics first.** Introduce one resolved-project interface with
   distinct local path getters and logical IDs while preserving current local
   keys. Convert board orchestration, worktree operations, mirrors, quota sweeps,
   harvesting and metrics. Remove duplicate resolver implementations. Verify
   normal and linked-worktree operation before changing any database partition.
2. **Inventory all writers and namespaces.** Enumerate local DB bypasses, SQL
   RPC callers, sessions, facts/capsules, events/cursors, claims/locks, consult
   state, board filters, mirrors and logs. Namespace execution IDs and add source
   location/presence fields; classify intentionally global facts explicitly.
3. **Enroll one managed project.** Mint tenant/project/repository IDs and bind two
   developers' clones, executor locations and one authoritative store. Verify
   access before enabling writes; do not globally switch all projects at once.
4. **Plan the graph migration.** Export a consistent backup and a dry-run alias
   map. Pause/fence writers or implement a reviewed server-side cutover barrier.
   Use one transactional migration with row counts, referential checks, sequence
   reconciliation and a retained mapping from legacy keys to new identity.
5. **Handle occupied destinations explicitly.** Existing `coord project rekey`
   is useful only for its narrow empty-destination rename case. It updates six
   project-scoped tables plus `events.$.project`, does not merge graphs, checks
   destination work before entering its transaction, and does not migrate global
   lane facts or local path assumptions. Extend via a planned migration, not a
   series of blind rekey calls. Decide which historical graphs represent duplicate
   snapshots and which contain independent work; never merge by equal work label.
6. **Preserve provenance.** Give imported independent work an unambiguous ID and
   remap parent/dependency edges, claims, results and references consistently.
   Preserve legacy project/work labels and original event provenance in migration
   records. Do not silently rewrite an immutable enterprise audit trail; the
   existing historical event rewrite needs a deliberate compatibility policy.
7. **Cut over without duplicate writes.** All managed writers use the canonical
   authority and resolver version. Reject obsolete writable aliases or resolve
   them server-side under the migration map; do not let old clients recreate old
   partitions. Keep mirrors read-only and local-path generation separate.
8. **Verify rollback semantics.** Before new writes, a failed migration can roll
   back transactionally. After new authoritative activity, restoring an old DB
   would discard work: use a forward correction or reviewed reverse mapping and
   reconciliation. Keep fencing and idempotency effective throughout.

The current rekey command must not be run on live corporate graphs merely to
demonstrate this design. Identity migration and graph import require a reviewed
mapping and recoverable backup; this audit performed neither.

## Acceptance tests

| Scenario                                                | Required outcome                                                             |
| :------------------------------------------------------ | :--------------------------------------------------------------------------- |
| Two clones, same enrolled source                        | Same logical project; distinct checkout/worktree/executor bindings           |
| Main and linked worktrees, moved checkout, symlink path | Logical ID stable; correct local paths and Git operations                    |
| SSH/HTTPS origins, multiple remotes, mirror             | Registry interpretation resolves intentionally; no heuristic graph merge     |
| Fork with copied hint                                   | No inherited authority or unauthorized project access                        |
| Same directory/URL across tenants                       | No cross-tenant graph, KB, facts, WS or starter visibility                   |
| Same `W1` in two projects; `W1.23` versus `W12.3`       | Distinct lanes, capsules, cursors and native session bindings                |
| Two hubs claim the same item simultaneously             | Exactly one accepted authoritative claim                                     |
| Remote bootstrap and consult                            | Presence, claims and expert discovery use the same authority                 |
| Board on another host                                   | Uses an authorized executor binding, never executes a foreign path locally   |
| Dead host versus repeated PID on another host           | No false liveness or unsafe reclamation based on local PID alone             |
| Authority outage/failover/old hub reconnect             | No silent writable fork of the graph; obsolete epochs rejected               |
| Migrating occupied independent graphs                   | Work and dependency identities preserved without loss or accidental collapse |
| Starter reused at another revision/dirty checkout       | Shared project recognized, evidence freshness independently checked          |

Run parsing/resolution/schema tests in disposable homes and stores, then a real
two-executor integration test with race/failover scenarios. Never aim broad
legacy suites at production state; some tests depend on import-time HOME binding.

## First deliverable

The first implementation should separate project IDs from paths and centralize
resolution across existing consumers. Next, prove two enrolled clones sharing
one authoritative work graph, with distinct globally unique lanes and correctly
scoped consult/notification access. Native starter distribution and broader hub
failover follow that foundation. This is larger than replacing `projectIdentity`
with a URL hash, but it can be delivered in these verifiable stages.

## Upstream visibility of downstream lanes

An upstream hub should see authorized lanes whose requests actually traverse it,
with grouping/filtering by downstream hub. This is an observability relationship,
separate from work ownership and source-code execution. The upstream owns its
traffic observations and local resource controls, not the downstream lane's work
claim, lifecycle or developer decisions.

```text
Lane L originates on developer executor E, governed by project authority P
    -> downstream hub A -> regional hub B -> corporate hub C -> model

A, B and C observe L's requests; P remains the work authority.
B groups immediate downstream traffic under A.
C groups immediate downstream traffic under B, with permitted drill-down to A.
```

Visibility should follow recorded request edges rather than assuming a fixed hub
tree. Routes may change, branch across providers or bypass an upstream. A lane
that never used hub C should not appear as locally observed traffic on C merely
because its project is in the corporate directory. A broader authorized fleet
directory can be offered as a distinct view with explicit source provenance.

### Separate a lane from its observations

The authoritative lane descriptor contains global lane/attempt IDs, tenant/project
IDs, origin executor/hub and permitted work metadata. Each observing hub records
its own minimal observation: lane/attempt, request correlation ID, immediate
downstream peer, observing hub, request/attempt timestamps, route edge/span,
outcome and provider-reported usage where available. Origin hub and immediate
downstream hub are different grouping dimensions.

Authenticate the connection peer, then validate delegated lane attribution
against its allowed tenant/project namespace. Strip untrusted incoming identity
headers and reconstruct or verify the forwarded envelope. The origin/authority
binding needs provenance; the actual route needs hop observations. Neither a
caller-supplied `/w/<slug>` nor an arbitrary claimed route list establishes trust.
Use bounded metadata, loop/hop checks and unique IDs; attach trace metadata
outside the stable model prompt so hub hops do not invalidate cached context.

Existing source provides useful attribution anchors, but not this complete flow:

- `packages/buckle/src/citizenship.ts` parses the `/w/<slug>` prefix and strips
  it before upstream dispatch. Its local audit attribution is not automatically
  a portable lane identity across another gateway.
- `packages/buckle/src/ledger.ts` records lane and request ID in route audit;
  use these as integration anchors while adding tenant/project/origin/peer scope.
- `packages/suspenders/scripts/dispatch-next.ts` currently skips its local buckle
  attribution setup when a named hub redirect wins. Explicitly verify attribution
  on redirected and multi-hop paths instead of assuming existing local adoption
  covers downstream lanes at every hub.

### Visibility does not imply control or complete liveness knowledge

Authorize metadata separately from observing transport traffic. A hub operator
may need origin ID, counts, model, latency and errors without permission to read
task titles, repository paths, source, transcripts or prompts. Only project
authority permissions allow richer drill-down, work changes or direct consults.
Upstream resource controls can restrict that peer/lane's local traffic without
reclaiming downstream work or rewriting its lifecycle.

An observation can be streaming, recently seen, idle, expired or unknown. "Last
request 10 minutes ago" does not prove a lane is dead or finished. Authoritative
lane status is a separately sourced field with freshness; without that feed the
upstream shows unknown. Never mark work done or reclaim a claim solely from
traffic inactivity. Lack of visibility after a route change is expected.

Deduplicate lane rows by globally scoped lane/attempt identity, while retaining
their multiple incoming edges. Keep request and retry-attempt IDs distinct so
retries are visible and not mistaken for more lanes. Each hop's latency/counts
are local observations; summing all hops can double-count one logical request.
Designate a usage/accounting source and reconciliation rules for billing rather
than treating upstream and downstream observations as independent model spend.

### GUI behavior under a busy hub

Default to a downstream summary with counts, active streams, traffic, errors and
last-seen freshness. Keep the hub's own originating lanes separately visible;
expand a selected downstream into paginated lane detail. Provide:

- Immediate downstream grouping for operational responsibility.
- Origin downstream grouping for identifying the original team/hub across hops.
- Authorized project, lane/attempt, time window, observation state and error
  filters; show whether status is observed locally or reported by an authority.
- Saved operator filters and a bounded recently-seen window; keep historic
  observations accessible on demand instead of retaining every lane forever
  in the live board.

Aggregate and filter server-side before publishing bounded push updates. Do not
broadcast every descendant lane event to every browser and hide rows with CSS.
Use indexes on observer/peer/time and lane scope, bounded retention, paginated
drill-down and explicit backpressure/resync behavior. Authorize counts and group
labels as well as detail rows. One multi-hop lane should remain one lane in the
selected scope even if it has several observation edges.

### Integration acceptance

Exercise A -> B -> C and verify correct immediate-peer/origin filters at each
hub. Reroute A directly to C and retain accurate time-scoped history without
inventing current B traffic. Test retries, multiple paths, forged identity,
cross-tenant detail access, offline authority, idle-but-live lanes and revoked
permissions. Under a configured busy-hub load, summary and filtered push payloads
remain bounded and one logical request is not billed once per hop.

This extends the identity design: globally stable lanes enable observation
deduplication, while project authority and executor identity keep visibility from
becoming accidental ownership. No multi-hop telemetry or GUI change is implemented
by this document.
