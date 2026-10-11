# W458.6 — starter registry first milestone: the integration proof

Item: W458.6 (first milestone: 1 project, 2 hubs, 2 developers, same starter) ·
Branch: `suspenders/W458.6` · 2026-10-11 · runner:
`packages/suspenders/scripts/starter-milestone.ts` · spec:
[starter-registry-architecture.md](starter-registry-architecture.md).

Built on W458.1–.5, all landed on this branch: 1ae29e4 (artifact schema +
registry store), 04e7ba3 (authorization + revocation + hub replication),
fb56c9c (materialization contract), 2f38ddc (cache-boundary honesty +
per-lane telemetry), 111ed99 (promotion evals + rollback authority).

## Run it

```sh
bun packages/suspenders/scripts/starter-milestone.ts
```

Deterministic: tmpdir-only, no network, no model calls. Exit 0 = every
acceptance proved, exit 1 = first failed step. `--out <dir>` relocates the
evidence file.

## What the seven acceptances mean

| #   | Acceptance                                            | Proof steps                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Authorization + revocation proven, refusal observable | authz.pregrant-materialize, authz.promote-refused, promotion.gated/bootstrap-no-target/rollback-target, replication.bytes-identical, revocation.rollback-recorded, revocation.project-refuses-v2, revocation.v1-still-served, revocation.hub-refuses-local-copy, revocation.hub-replication |
| 2   | Independent lane ownership                            | ownership.lane-a, ownership.lane-b; author/promoter identities refused (fresh identity required)                                                                                                                                                                                            |
| 3   | Instruction freshness offline                         | freshness.stale-refused at +40d, freshness.day-old-allowed at +1d (`STARTER_FRESH_DAYS`, default 30)                                                                                                                                                                                       |
| 4   | Fork vs reconstruction recorded                       | route.native-fork-recorded (claude), route.reconstruction-recorded (grok)                                                                                                                                                                                                                   |
| 5   | Cold-start from artifact alone                        | coldstart.wiped, coldstart.repulled, coldstart.digest-verified, coldstart.digest-travels, coldstart.materializes, coldstart.inventory                                                                                                                                                       |
| 6   | Cost + correctness vs baseline                        | outcomes.per-lane-attribution + sim table over the W454 paired-bench constants                                                                                                                                                                                                              |
| 7   | Failover keeps metrics + attribution                  | failover.attribution-survives — hub-a deleted; hub-b replica carries all rows, per-lane split + hitShare intact                                                                                                                                                                             |

## Full unedited run output (2026-10-11, exit 0, 26/26 PASS)

```text
W458.6 first-milestone proof — 1 project, 2 hubs, 2 developers, 1 starter
project:  /var/folders/1f/_ty2zyvn2x70rp079shts3lw0000gn/T/w4586-project-yxVoIX
hub-a:    /var/folders/1f/_ty2zyvn2x70rp079shts3lw0000gn/T/w4586-hub-a-0BDCvY
hub-b:    /var/folders/1f/_ty2zyvn2x70rp079shts3lw0000gn/T/w4586-hub-b-JvC4Jm

PASS  authz.pregrant-materialize  starter authz refused — lane-a holds no materialize grant
PASS  authz.promote-refused  starter authz refused — lane-a holds no promote grant
PASS  promotion.gated  measured lift clears the gate
PASS  promotion.bootstrap-no-target  no rollback target: fleet-orientation v1 has no prior version
PASS  promotion.rollback-target  v2 → v1 (ccba1327 → 0b6322bc)
PASS  replication.bytes-identical  mirror 2 rows, hub-a 2, hub-b 2, digests re-verified on read
PASS  ownership.lane-a  materialized v2 as lane-a
PASS  ownership.lane-b  materialized v2 as lane-b
PASS  ownership.author-identity-refused  identity lane-aut built or promoted this starter — fresh identity required
PASS  ownership.promoter-identity-refused  identity lane-pro built or promoted this starter — fresh identity required
PASS  freshness.stale-refused  no compatible fresh authorized starter for fleet-orientation; refusals: fleet-orientation v1: stale; fleet-orientation v2: stale
PASS  freshness.day-old-allowed  age 1d ≤ max 30d
PASS  route.native-fork-recorded  claude → native-fork
PASS  route.reconstruction-recorded  grok → reconstructed
PASS  revocation.rollback-recorded  v2 → v1 by lane-revoker
PASS  revocation.project-refuses-v2  fleet-orientation v2 revoked by lane-rev: rollback: eval regression on v2
PASS  revocation.v1-still-served  v1 survives the rollback
PASS  revocation.hub-refuses-local-copy  fleet-orientation v2 revoked by lane-rev: rollback: eval regression on v2
PASS  revocation.hub-replication  ship +1 rev, pull +1, hub log 1 row, v1 served
PASS  coldstart.wiped  hub-b registry wiped
PASS  coldstart.repulled  2 artifacts rebuilt from the mirror
PASS  coldstart.digest-verified  re-pulled bytes digest-verify on read
PASS  coldstart.digest-travels  digest ccba1327ee25… identical across hub + new project
PASS  coldstart.materializes  artifact alone → working materialization
PASS  coldstart.inventory  hub-b inventory: 2 versions
PASS  outcomes.per-lane-attribution  2 outcome rows: lane-a:native-fork, lane-b:reconstructed

cost + correctness vs fresh-lane baseline — SIM rows over the W454
orientation constants (this runner makes no model calls):
  lane                                 in-tok    wall    reuse  correct
  fresh-lane baseline (no starter)      10432      29.8s        0%     1/1
  starter fork, native route             1100      16.7s       98%     1/1
  delta vs baseline                  -89.5% tokens -44.0% wall prefix reuse   equal
  source: W454 paired bench (fork vs cold lane), correctness = gate-verified tasks
PASS  failover.attribution-survives  hub-a down; hub-b: 3 rows, lane-a 2, lane-b 1, hitShare 0.458

PASS  acceptance: authorization + revocation proven, refusal observable
PASS  acceptance: independent lane ownership, fresh identity enforced
PASS  acceptance: instruction freshness enforced offline
PASS  acceptance: native-fork vs reconstruction recorded, never assumed
PASS  acceptance: cold-start recovery from the artifact alone
PASS  acceptance: cost + correctness evidence vs fresh-lane baseline
PASS  acceptance: metrics survive hub failover, per-lane attribution kept

```

## Honest limits

- The cost/correctness rows are **sim rows**: the W454 paired-bench constants
  (fork 1100 tok / 16.7s vs cold 10432 tok / 29.8s, −89.5% tokens, −44.0%
  wall, correctness equal 1/1) replayed through the new telemetry/outcomes
  path — the runner makes no model calls. A live re-bench is an ops task,
  not part of this proof.
- The two hubs are tmpdir stand-ins: replication, revocation-merge and
  cold-start behavior run the real lib code, but no network hop is
  exercised.
- A `--bench` live option considered in planning was dropped on purpose —
  a live model bench would make the proof nondeterministic.
```
