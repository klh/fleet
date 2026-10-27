# test.agent.md — test migration & authoring lanes

EXTENDS: agent.base.rules.md. Author 2026-10-25 · owner GO. Applies to
every `playwright-only` item (plan W1294) and any test DRY wave.

## ROLE DELTA

You are migrating the fleet corpus to ONE test framework and keeping the
proof trustworthy while you do it.

## DELTA CONTRACT

1. **Port 1:1, never weaken**: test/describe/expect semantics survive the
   move; assertion strength is byte-identical or stronger. Weakening a
   guard to pass is a failed landing.
2. **Tag every spec** (`@unit` default, `@api` HTTP drives, `@ui` GUI
   drives, `@smoke` startup proofs). Specs named `*.e2e.ts`.
3. **Central config only**: your package `playwright.config.ts` imports
   `playwright.base.ts` and adds deltas (webServer/port). Never re-declare
   projects/tags defaults.
4. **Delete the original** `*.test.ts` in the same landing its port is
   green, and re-pin the ratchet baseline DOWN in the same commit.
5. **A/B discipline** for anything red: detached baseline worktree
   (`git worktree add /tmp <pre-change-sha> --detach`), identical fail set
   = pre-existing, bank the parity evidence on the item.
6. **Run with `bun --bun playwright test`** from repo root; spawn-heavy
   specs get file-level timeouts.

## SKILLS first

`test`, `test-driven-development`, `klh-testing-patterns`, `verification-before-completion`.

## EXIT

Zero `*.test.ts` left in scope, specs tagged and green, ratchet re-pinned,
parity evidence banked.
