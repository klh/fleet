# Starter registry and distribution architecture

Enterprise starter sharing: immutable, versioned starter artifacts in an
authorized registry, replicated to hubs, materialized per task under an
explicit contract. This document is the canonical architecture and acceptance
record; the implementation status is separated below from the design.

Source: [research synthesis](research-toto-gpt.md#enterprise-starter-sharing-across-hubs-and-developers).
Breakdown lives in the work graph as children of W458.

## Verified status after the initial proposal

W458.1–.5 delivered artifact, authorization/replication, materialization,
cache-boundary, and promotion modules in Suspenders, Buckle, and BLAM. The
[W458.6 milestone receipt](../packages/suspenders/docs/starter-milestone-w458-6.md)
records a deterministic 26/26 proof using two temporary hub stand-ins. It
made no model calls and exercised no network hop; its cost rows replay W454
constants. The work graph now marks W458.6 superseded by W695.

`materializeStarter` has callers in tests and the milestone runner, but no
dispatcher call in current main. The native fork path in dispatch is separate.
Thus the libraries and simulated milestone exist; live two-hub distribution,
dispatcher materialization, and measured production cache savings are still
unproved. Check `work show` and current code before treating any design below
as deployed behavior.

## Artifact model

Each starter artifact is immutable and versioned, and carries:

- instructions, skill versions, verified findings, source revision
- content digest + compatibility manifest (model/harness/tool compatibility)
- provenance and evaluation results

Store content-addressed, append-only versions. A native checkpoint may be
referenced where a harness supports import or remote forking; it is never
embedded — a session id on a developer's machine is not a portable artifact.
Secrets and private task conversations stay outside shared artifacts.

## Registry and distribution

An authorized registry is the only promotion surface; artifacts replicate to
hubs from immutable storage and cache locally. A registry may be shared
logically across hubs without one always-available central server. Revocation
and offline freshness policy are explicit: a hub must not silently use a
revoked or incompatible starter merely because it holds a local copy, and
permissions are rechecked when the artifact is materialized.

## Materialization contract

Per task, in order:

1. Authenticate the developer and enforce tenant/project access to starter
   content and its source evidence; recheck permissions at materialization.
2. Filter starters for compatibility and freshness, then rank by task scope
   and measured outcomes on comparable work.
3. Use a native fork when supported; otherwise reconstruct from the portable
   artifact. Record which route ran — never claim equivalent cache behavior
   or preservation of hidden model state.
4. Allocate fresh native session and Fleet lane identities, credentials,
   claims and an isolated worktree. Shared preparation must not imply shared
   ownership.
5. Record starter digest/version, execution route, cache usage where
   reported, cost and verified outcome — the selection evidence.

## Cache-boundary honesty

OpenAI prompt caches are separated by organization and processing region.
Claude's direct API isolates cache at the workspace level. Matching requests
must reach an available matching entry; routing and expiration make a hit
never guaranteed. Hubs benefit from a shared prefix only when their actual
upstream requests fall within the compatible provider boundary — never assume
reuse across separate customer accounts, workspaces, models or regions.
[OpenAI cache guidance](https://developers.openai.com/api/docs/guides/prompt-caching)
and [Claude cache guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
provide the provider-specific boundaries; verify them again before rollout.

The gateway preserves stable prefixes and supported cache controls, keeping
task identity and changing material after the reusable prefix. Cache keys are
routing/accounting aids, not authorization controls; enforce isolation
independently and do not collapse tenant boundaries for savings. Cache reuse
never authorizes reading another user's history.

For local inference, prefer warm workers when queue time, locality and load
justify it; a cold worker must still start correctly from the artifact. Verify
engine support before transferring KV state (weights, tokenizer, runtime/cache
format, hardware). Live GPU cache availability is never a correctness or
recovery dependency.

## Component split

| Component     | Responsibility                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Suspenders    | Starter registry metadata, authorization, selection, lane lifecycle and outcome evidence          |
| Buckle        | Upstream routing, supported cache controls, per-lane accounting and cache telemetry                |
| Hub executors | Artifact materialization, native fork/resume adapters and isolated worktrees                       |
| BLAM          | Representative evaluations and regression checks before candidate promotion                        |

## Promotion and revocation authority

BLAM evaluations gate every promotion; self-reported confidence is never the
promotion criterion. Each promoted version carries an explicit rollback
target. Rankings are project-specific: a starter that helps one project may
hurt another. Fork deliberate starter checkpoints, not arbitrary completed
lanes carrying stale assumptions. Automatic evolution is deferred until enough
comparable outcomes exist to separate improvement from noise — it is not a
prerequisite for the initial registry.

## First enterprise milestone

One project, two hubs, two developers, same immutable starter. Acceptance:

- authorization and revocation behavior proven (refusal is observable);
- independent lane ownership; fresh identity, claims, worktree per task;
- instruction freshness enforced offline;
- native-fork vs reconstruction behavior recorded, not assumed;
- cold-start recovery from artifact alone;
- total cost and task correctness compared against fresh-lane baselines,
  including preparation/distribution, cache writes, misses, queue delay and
  recovery overhead;
- metrics survive hub failover with per-lane attribution preserved.

Establish this distribution contract before fleet-wide automated evolution.

## Work-graph breakdown

| Item   | Scope                                                          |
| ------ | -------------------------------------------------------------- |
| W458.1 | Artifact schema + registry store (suspenders)                  |
| W458.2 | Authorization + hub replication + revocation (suspenders)      |
| W458.3 | Materialization contract (hub executors)                       |
| W458.4 | Cache-boundary honesty + per-lane telemetry (buckle)           |
| W458.5 | Promotion evals + rollback authority (blam)                    |
| W458.6 | First milestone: 1 project, 2 hubs, 2 developers, same starter |
