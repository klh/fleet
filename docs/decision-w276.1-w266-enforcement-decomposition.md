# W276.1 — W266 enforcement-layer decomposition (decision + plan)

Date: 2026-10-15 · Item: W276.1 (plan) · Child minted: W276.1.1

## State found

- W266 (opus answer: enforcement layer) shattered into .1 supervisor plane,
  .2 narrow bash gate, .3 P1 sweeps.
- **W266.2 landed properly on main** — `hooks/gates/bash.ts` +
  `hooks/gates/plane-loop.ts` + `hooks/lib/hookio.ts` + tests
  (bb7a84ea, verified ancestor of HEAD).
- **W266.1 closed on the graph but its code is parked-only**:
  `suspenders/parked/W266` carries 27b9e2ce (supervisor plane),
  ac20ea6e (schema pin), d5e47411 (gitleaksignore) — never merged. Main
  has moved: govdb is at v14 via the `govdb-open.ts` migration ladder;
  the parked migration assumed v11 was free (it is not — v11 is the
  knowledge-split/W243 slot). `hooks/coord/supervisor.ts`,
  `hooks/lib/supervisor.ts` and the `coord supervisor` verb do not exist
  on main.
- W266.3 (P1 rogue-process sweep in the fleet-loop tick + laws.md mirror
  CI check) is READY, nothing landed.

## Decisions

1. **Re-land the supervisor plane as ONE item** (W276.1.1): govdb
   migration + coord verb + SessionStart fact are one contract split
   across three files; splitting them yields unshippable halves.
2. **Migration renumbers to v15** (next free after W603's v14), written
   in the `govdb-open.ts` ladder style (`if (uv < 15)`), replacing the
   parked commit's stale 10→11 pins. Router-tables/coord-diff/
   knowledge-split version-pin tests follow the current test convention.
3. **W266.3 stays as-is.** It is READY and self-describing; its two
   scopes (fleet-loop rogue sweep, laws.md mirror CI check) are
   independent and can be split by whoever takes it. No re-scope here.
4. **Naming collision, documented not fixed**: W266.1's `coord
supervisor` (launchd supervision: ensure/status verb, plist-from-
   template, governor.db row) vs W637's "supervisor-default loop"
   (SessionStart arm-loop directive) are distinct mechanisms that share
   a word. The parked session-start hunk re-applies alongside W637's
   arming code — do not conflate or merge them.

## Landing plan (for W276.1.1)

1. Cherry-pick the 3 parked commits onto a fresh branch off main.
2. Rewrite the schema bit as the v15 rung; drop the parked 10→11 pin
   commits' version claims.
3. `hooks/coord/supervisor.ts` (105 ln) lifts near-verbatim;
   `hooks/lib/supervisor.ts` (292 ln) likewise; coord.ts verb wiring is
   redone against the current (W428/W624-restructured) dispatch.
4. session-start.ts: re-apply the 24-line supervision-fact hunk next to
   W637 arming.
5. `test/supervisor.test.ts` (462 ln, all IO stubbed) lifts.
6. Re-check the W270 gitleaksignore fingerprints against current test
   files before re-adding.
7. Verify: `bun test packages/suspenders/test/supervisor.test.ts
packages/suspenders/test/govdb-router-tables.test.ts`; then
   `coord supervisor status --json` against live launchd on the Mac hub.
