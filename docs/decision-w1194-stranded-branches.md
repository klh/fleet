# W1194 — Merge-guard-stranded branches: superseded, not stranded

Decision record, 2026-10-23 (lane autow1194-p98b319584008df14).

The merge ladder rejected four DONE-item branches on conflicts
(NEED_DECISION #56344–#56347, fleet-loop, 2026-10-22T21:11Z — the mission
brief's "#56344-46" was a miscount; there are four events, one per branch).
Investigation shows all four are **superseded**: every commit on every branch
is patch-equivalent (identical `git patch-id`, verified via `git cherry`) to a
commit already in main, and every twin is a main ancestor. Re-merging would
add nothing; the conflicts the ladder hit were against later evolutions of the
same content.

## Disposition

| Branch | Head | Superseded by | Twin in main |
| --- | --- | --- | --- |
| `parked/W1072.2` | `01607ef8` "fail-closed merge gates" | landed directly on main's first-parent chain (carried through the `suspenders/W1102.1` belt-wired-guard lineage) | `c0e43298` |
| `parked/W1106.2` | `668272df` "source-faithful bridge terminals" | `suspenders/W1106` (re-landed W1106 stack, merges `14fc1d62`/`95623093`); extended by W1160 terminal-verdict work (`ecf65a00`, `3cabcc33`) | `22322e37` |
| `parked/W1124.12` | `ae155e9b` "scoped managed-worker profile for lanes" | main integration `8ba7d681` "Integrate reviewed worker argv and bounded default-off starters" | `ec43ac4e` |
| `parked/W1124.4` | `ef57f9d7` "AnthropicToOpenAIStream must not synthesize success" | `suspenders/W1106` lineage (same merges `14fc1d62`/`95623093`) | `39deba5e` |

The three-way add/add on `w1106-bridge-terminal.test.ts` (conflicted across
W1106.2 and W1124.4) is moot: main holds a further-evolved version of the
test, built on the re-landed W1106 stack — the winning branch is
`suspenders/W1106`.

## Method

1. `git cherry main <branch>` — every unmerged commit on all four branches
   returned `-` (patch-equivalent present in main).
2. Twin identification by identical commit subjects, then
   `git merge-base --is-ancestor <twin> main` — all four confirmed ancestors.
3. Landing-lineage tracing via `--ancestry-path --merges` to name the winning
   branch per row above.

## Acceptance

- Zero outstanding NEED_DECISION merge-reject decisions: all four events
  (#56344–#56347) are dispositioned — superseded, winning branch named.
- Each of the four branches dispositioned; branches preserved under `parked/*`
  (not deleted, per the mission's preservation clause).
- No code landing, so no suite run is required; buckle + suspenders suites
  were green on the already-landed content at its own landings.
