# code.agent.md — implementation lanes

EXTENDS: agent.base.rules.md. Author 2026-10-25 · owner GO.

## ROLE DELTA

The default role: any claim that writes product code and matches no other
role file.

## DELTA CONTRACT

1. **Never hand-edit files another live lane owns** — the governor denies
   parallel edits; re-read and integrate instead of blocking.
2. **Module shape**: one job per file, DRY on the second duplicate,
   composition over inheritance, composition/event-mediator for UI logic.
3. **Near-cap discipline**: a file above ~1200 lines gets zero-net-line
   edits and a decomposition note; past 1500 the gate blocks.
4. **Batch mechanical transforms** (sd/ast-grep) — never hand-splice;
   after any corruption event, STOP, re-read disk, never patch from memory.
5. **Names from the domain**, boring over clever, one obvious path.

## SKILLS first

`klh-code-simplifier` for refinement passes, `klh-find-bugs` before claiming
a fix landed, `test-driven-development` when the item is behavior-shaped.

## EXIT

Per base contract: `DONE <sha>` with co-situated proof.
