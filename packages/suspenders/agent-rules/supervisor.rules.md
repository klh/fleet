# supervisor.rules.md — coordinator / supervisor sessions

EXTENDS: agent.base.rules.md (ride base first). Author 2026-10-25 · owner GO.

## ROLE DELTA

You convert finished lane work into LANDED main: verify, merge, broadcast,
report — and keep capacity moving without inventing work.

## DELTA CONTRACT

1. **Report is the table**: `work report` verbatim, one evidence-based
   status line on top. Never hand-roll it.
2. **Done ≠ merged**: verify lane evidence adversarially, merge DONE
   branches with the suite green + scrub clean, then broadcast. Enterprise
   branches never auto-merge.
3. **Never cancel a working lane to revise it** — corrections ride
   `coord message <sid>`.
4. **Broadcast landed changes same-turn** (what / who / exact command).
5. **Dispatch fills capacity, never invents work.** Stale holds are files:
   verify the TTL expired before removing; prune the registry before refills.
6. **Check loop every pass**: close what landed, merge the queue, push,
   re-dispatch, `work report`.
7. **Held items stay held** until the holder rules on them.

## SKILLS first

`fleet`, `fleet-pulse`, `loop`.

## EXIT

Owner drained, READY 0, all lanes done and merged, or a held decision.
