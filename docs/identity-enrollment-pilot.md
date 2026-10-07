# Managed-project enrollment pilot: identity migration stage 3

Stage 3 of the migration plan in
[cross-hub-project-identity.md](cross-hub-project-identity.md). Where the audit
defined the identity model and hazards, this document specifies the first
bounded enrollment: one managed project, two developers' clones, one
authoritative store. Verified access before enabled writes; no global cutover.
Audit date 5 October 2026 (baseline `c65a7ff`); source anchors here were
re-verified against the working tree on 7 October 2026.

## Scope and non-goals

The pilot proves the acceptance rows it can reach without touching graph data:

| In scope                                           | Out of scope (later stage / owner call)                   |
| :------------------------------------------------- | :-------------------------------------------------------- |
| Mint tenant/project/repository IDs in one registry | Merging any existing graph partitions (stage 4, W459.4)   |
| Bind two clones + one authority store, read-first  | Repointing any legacy local-keyed graph (stage 4)         |
| Verify access before enabling writes               | Global rollout to unenrolled projects                     |
| Fork, rename and re-spell negative tests           | Multi-hub authority failover and epoch fencing (stage 4+) |
| Rollback = disable one registry row                | Starter distribution and multi-hop lane observation       |

Non-goals are binding: the pilot runs beside the legacy local-keyed graphs, and
enrollment changes no existing key. Unenrolled repos keep today's behavior
exactly.

## Pilot target and prerequisites

Pilot project: **this repository** (fleet), chosen because both executors, both
clones and the authority store are already under the owner's control and a
failed gate costs nothing. Tenant and machine values below are placeholders per
the config-over-code law — real values live only in machine-level config
(`~/.config/klh/stack.yaml`, `~/.claude/local-llm/*.env`), never in this repo.

Prerequisites, each gated:

1. **Backup first.** A consistent backup of the authority store exists and was
   verified restorable per `packages/suspenders/docs/hub-backup-dr-runbook.md`.
   Stage 3 migrates no graph rows, but the registry inserts are authoritative
   state; back up before the first mint.
2. **Resolved-project interface landed** (stage 1, W459.1): one
   `projectIdentity`-shaped interface exposing logical ID and local path getters
   separately. Gates below reference "the resolver"; if stage 1 is still in
   flight, substitute the current `projectIdentity()` and treat the pilot as
   validating its replacement requirements instead.
3. **Execution-ID namespacing landed** (stage 2, W459.2). New lanes already
   carry a project hash (`laneSid`, `packages/suspenders/hooks/lib/laneslug.ts`,
   W460), but capsules, cursors, locks and fact scopes still use global
   namespaces — stage 2 classifies and namespaces them. If stage 2 is still in
   flight, gates that touch those tables run read-only.
4. **Authority store reachable with its token.** The store server
   (`packages/suspenders/hooks/bin/store-server.ts`) already exposes
   `POST /rpc` over loopback with optional `x-governor-token`
   (`store-server.ts:343`); the pilot adds no new network surface.
5. **Enrollment verbs implemented** (follow-up work item minted from this
   document). The runbook's `coord project enroll` / `bind` / `verify` verbs are
   a proposed surface — until they exist, the pilot cannot run and no gate
   passes by hand-waving.

## ID minting rules

IDs are opaque, minted once, never derived. This is the hard break from
`projectIdentity()` (`packages/suspenders/hooks/lib/govdb.ts:25`), which derives
identity from the filesystem: a derived string changes when the filesystem
changes (clone location, remote re-spelling), so it cannot serve as durable
identity across executors.

- **Format:** `<prefix>_<UUIDv4>`, lowercase, `crypto.randomUUID()` — e.g.
  `tnt_9f1c…`, `prj_4a2b…`, `rep_7d0e…`, `exe_…`, `chk_…`, `wtk_…`.
  Self-describing prefixes keep logs greppable.
- **Minted once, on the authority,** inside one registry transaction. A mint
  is never repeated for the same enrolled source: the registry's uniqueness
  constraint on `(tenant_id, provider, provider_repo_id)` refuses a second
  `id_repositories` row and returns the existing `project_id`.
- **Never derived from** paths, URLs, display names or remote spelling. SSH vs
  HTTPS, mirrors and transfers are locator changes interpreted by the registry,
  not identity events.
- **Display labels preserved.** Work items keep their `W<n>` labels; only the
  graph partition key changes in stage 4. The pilot mints no work labels.
- **Loss of the registry is loss of identity.** The registry lives in the
  authority store and rides the same backup/restore discipline.

## Registry (authority store, sketch)

New tables appended to the authority schema — placeholders only, no code in
this stage:

```sql
CREATE TABLE IF NOT EXISTS id_tenants (
  tenant_id  TEXT PRIMARY KEY,              -- tnt_…
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS id_projects (
  project_id     TEXT PRIMARY KEY,          -- prj_…
  tenant_id      TEXT NOT NULL REFERENCES id_tenants(tenant_id),
  display_name   TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL DEFAULT 1,
  writes_enabled  INTEGER NOT NULL DEFAULT 0, -- the write gate
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS id_repositories (
  repository_id    TEXT PRIMARY KEY,        -- rep_…
  project_id       TEXT NOT NULL REFERENCES id_projects(project_id),
  provider         TEXT NOT NULL,           -- e.g. 'github'
  provider_repo_id INTEGER NOT NULL,        -- GitHub's numeric API id
  canonical_url    TEXT,                    -- locator only, never authority
  created_at       INTEGER NOT NULL,
  UNIQUE (provider, provider_repo_id)       -- one repo = one row, ever
  -- plus a partial index refusing a second project for the same source:
  -- UNIQUE (tenant_id, provider, provider_repo_id)
  -- (SQLite requires the partial-index form for NULLable locator columns)
);
```

`writes_enabled` is the stage's central control: the registry row starts at 0
and only the operator flips it after verification gates pass. Every managed
writer checks it server-side — a client-supplied `project_id` is a selection
key, never proof of authorization (audit §Authority).

## Checkout binding

After verification the executor records a local binding file, mode 600, in
machine config — not in the repository:

```json
{
  "schema": 1,
  "tenant_id": "tnt_…",
  "project_id": "prj_…",
  "repository_id": "rep_…",
  "executor_id": "exe_…",
  "checkout_id": "chk_…",
  "authority": { "url": "http://127.0.0.1:<port>", "epoch": 1 },
  "local": {
    "repo_root": "<absolute path, executor-local>",
    "common_git_dir": "<absolute path, executor-local>",
    "resolved_at": 0
  },
  "verified": {
    "provider": "github",
    "provider_repo_id": 0,
    "verified_at": 0,
    "verified_by": "enrollment-v1"
  }
}
```

A committed repository **hint** may point at the registry (`.klh/repo-hint.json`
in the repo — `.fleet/` is gitignored, so it cannot carry a committed file), but
a hint supplies a candidate, not membership: enrollment still authenticates the
developer and executor, then verifies the hint's `provider_repo_id` against the
registry and the provider API. A fork that inherits the hint file by git does
not inherit anything else.

## Enrollment flow (fail-closed)

Five steps from the audit's resolution contract, each failing closed: on any
failure the checkout keeps its local identity namespace, no `project_id` is
minted locally, and no shared-store write occurs — a failed resolution must
never leave a writable graph masquerading as the managed project.

1. **Authenticate** tenant, developer and executor independently of any
   repository text (existing store token / key chain; no new credentials in
   stage 3).
2. **Read the hint** (`.klh/repo-hint.json`) or accept an operator-supplied
   repository reference. The hint is a candidate.
3. **Verify source identity:** resolve the hint against the provider API
   (GitHub's repository endpoint returns the numeric API id plus fork/parent
   metadata — locator, not authority) and against the registry row.
   Mismatch = refuse.
4. **Resolve authority** independently of gateway selection: the registry
   project row's store URL and current `authority_epoch`.
5. **Record the checkout binding:** one `id_checkouts` row + the local binding
   file, only after 1–4 passed.

The enrollment verbs emit events (`identity.enrolled`, `identity.binding_set`,
`identity.writes_enabled`, `identity.denied`) to the store's existing events
table — the audit trail is the store's, not a side log.

## Pilot runbook

Every gate prints evidence before the next runs. Placeholders: `<tenant>`,
`<store-url>` — real values from machine config. Commands are the proposed
enrollment surface; each gate names the deliverable it depends on.

### G1 — mint (registry writes begin)

One transaction on the authority store: tenant, project
(`writes_enabled=0`), repository (registered to the real provider id). Verify:

```text
coord project enroll --tenant <tenant> --repo <url> --display "fleet"
→ tenant/project/repository rows exist; writes_enabled=0
→ re-running with the same source returns the SAME project_id (idempotent,
  no second mint)
→ re-running with a different tenant refuses
```

### G2/G3 — bind developer A, then developer B

Same steps on two different executors with independent clones:

```text
coord project bind   # on each executor, inside its clone
→ authenticates, verifies hint vs registry vs provider API
→ writes one id_checkouts row (chk_…, exe_… per executor)
→ writes ~/.config/klh/identity/binding.json (0600)
→ refuses when writes_enabled=0? NO — binding is verified read-only access;
   write ENABLEMENT is a separate, later flip (G5)
```

### G4 — same source, same project, distinct bindings (read-only proof)

Run from each clone; compare:

```text
coord project verify
→ A: project_id=prj_X  checkout=chk_A  executor=exe_A  common_dir=<pathA>
→ B: project_id=prj_X  checkout=chk_B  executor=exe_B  common_dir=<pathB>
```

Required: identical `project_id`; all four binding fields distinct. Add a
linked worktree under clone A and re-run: same `project_id`, same `chk_A`
(worktrees share the checkout's common dir), distinct `wtk_…` when worktree
binding exists. This is the acceptance row "Two clones, same enrolled source →
Same logical project; distinct checkout/worktree/executor bindings", plus the
worktree row, proven read-only.

### G5 — enable writes (the one flip, then prove shared authority)

After G4 evidence exists, the operator flips the single row:

```text
coord project enroll --enable-writes --tenant <tenant> --project prj_X
→ writes_enabled=1, authority_epoch unchanged, one event row
```

Then prove both clones act on one authoritative store — sequentially, not
racily (the simultaneous-claim race belongs to stage 4's fencing):

```text
clone A: work add "enrollment pilot scratch item"   → lands in the
         project_id-keyed managed namespace on the shared store
clone B: work ready                                  → sees the item
clone B: work take  … , work done … --sha …          → claim + close visible
         to clone A
```

The managed namespace is keyed by `project_id`, NOT by either clone's local
`projectIdentity()` string. Legacy local-keyed graphs keep running untouched —
this is why the stage is not a cutover: two namespaces coexist by design, and
the pilot's writes are new items only.

### G6 — negative tests (must all refuse)

1. **Fork with copied hint:** clone a fork (it inherits `.klh/repo-hint.json`
   via git), run `coord project bind` → refused: provider id ≠ registered id;
   no binding written, no store write. **No inherited authority.**
2. **Remote re-spell:** add `ssh://` and `https://` remotes for the enrolled
   source on a third clone; bind → resolves to the SAME `repository_id`/
   `project_id` (registry interprets locators; no heuristic second project).
3. **Wrong tenant:** `bind --tenant <other>` → refused; no cross-tenant row.
4. **Unenrolled repo:** a repo without a hint behaves exactly as today — local
   namespace, no registry contact.

## Rollback

Stage 3 migrates no graph rows, so rollback is state subtraction, not restore:
disable the project row (`writes_enabled=0`), remove the two binding files and
the `id_checkouts` rows, keep the minted IDs and event rows as audit history.
If the registry itself is corrupted, restore the authority store per the DR
runbook. A rollback after G5 discards only the pilot's scratch items.

## Acceptance coverage

| Parent acceptance row                                                                                                 | This stage                                                                                    |
| :-------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| Two clones, same enrolled source                                                                                      | **Proven** (G4 + G5)                                                                          |
| Main and linked worktrees, moved checkout, symlink path                                                               | Worktree subset **proven** (G4); moved-checkout subset deferred                               |
| SSH/HTTPS origins, multiple remotes, mirror                                                                           | Re-spell subset **proven** (G6.2); mirror deferred                                            |
| Fork with copied hint                                                                                                 | **Proven** (G6.1)                                                                             |
| Same directory/URL across tenants                                                                                     | Refusal **proven** (G6.3); visibility isolation deferred                                      |
| Same `W1` in two projects; `W1.23` vs `W12.3`                                                                         | Lane slugs already injective (W460); namespace proof = stage 2                                |
| Simultaneous claims, board-on-foreign-host, PID liveness, authority failover, occupied-graph migration, starter reuse | **Deferred to stage 4 (W459.4) and later** — these need epoch fencing and the graph migration |

## Dependencies and follow-ups

- Stage 1 (W459.1) resolved-project interface, stage 2 (W459.2) namespacing —
  prerequisites for gates G2+.
- Implementation follow-up (minted as a work-graph child of W459): the
  `coord project enroll/bind/verify` verbs, the registry tables, and the
  binding-file writer. This document is the design those verbs implement.
- The fork negative test needs a real fork of the pilot repo; mint it under
  the owner's account when the pilot runs.
