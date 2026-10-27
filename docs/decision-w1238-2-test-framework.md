# Test-framework law — W1238.2 (2026-10-23)

Status: **DECIDED — documented deviation** (bun:test stays as the unit/integration
runner; @playwright/test stays the ONE browser/e2e + load framework). Emitted to
the owner as NEED_DECISION for ratification the same day; this record is the
recommendation packet. Evidence re-runnable from the probes below.

Checklist item: principle 7 of `docs/paas-engineering-standard-2026-10-23.md`
(the owner standard — referenced by W1238, not committed to the repo at
74605857): *ONE test framework = @playwright/test, same specs rerun as load*.

## Census at 74605857 (verified this session)

- 737 `*.test.ts` files (~154k LOC) import `bun:test`, across 9 packages:
  suspenders 486 · buckle 120 · belt 100 · blam 10 · telemetry 5 ·
  local-llm 5 · speedy 4 · local 4 · decant 3.
- @playwright/test exists ALREADY as the e2e tier: one config
  (`packages/suspenders/e2e/playwright.config.ts`) + 24 `*.spec.ts` under
  `packages/suspenders/e2e/`, LAN-run via
  `bun x playwright test --config e2e/playwright.config.ts` (serial
  single-worker per the W353 config; browsers resolve from the machine
  cache, never a CDN fetch), not wired into root CI. **Census correction to the W1238
  review row:** the config/specs are not zero — the review's rg pattern
  matched only `*.e2e.ts`; the specs are named `*.spec.ts`.
- Load story today = the root CI `docker-e2e` job, not a load project.

## Probes (decisive, re-runnable)

Probe A — official runner path (Node): a @playwright/test spec importing a
bun-native module fails at load:

    $ bunx playwright test --config <cfg>   # spec imports bun:sqlite
    Error: Only URLs with a scheme in: file, data, and node are supported by
    the default ESM loader. Received protocol 'bun:'

Probe B — runner under the Bun runtime:

    $ bun --bun x playwright test --config <cfg>
    error: Playwright Test did not expect test() to be called here.
    ...

Both legs fail, so "migrate the 737 files" is not an import swap — it is a
rewrite of the testing substrate:

- 319 non-test source files use `bun:sqlite` / `Bun.*` APIs; testing them
  in-process REQUIRES the Bun runtime (probe A makes that impossible under
  the PW runner on Node).
- The test bodies themselves are Bun-native: `Bun.spawnSync` in 478 files,
  `Bun.serve` 236, `Bun.sleep` 228, `Bun.spawn` 171, `Bun.write` 101,
  `Bun.file` 97 — every one a rewrite, not a rename.
- ~154k test LOC. Even at an optimistic 10 min/file for import + API parity +
  runtime fixes, that is ~120 lane-days — and probe A/B show no parity path
  exists at all for the Bun-native share.
- bun:test-only APIs in play: `mock.module` (2 files), `spyOn` (1 file),
  zero `toMatchSnapshot`/`setSystemTime` — the API gap is small; the RUNTIME
  gap is the blocker.

## Decision

**bun:test and @playwright/test are both sanctioned, split BY LAYER —
principle 7 is recorded as a documented deviation: "one framework per
test layer", not "one framework total".**

- Unit/integration (`*.test.ts`, `bun test`): stays bun:test. Bun-native
  in-process testing of Bun-native code is the point of the fleet
  ("TypeScript run by Bun" automation doctrine; native-first is principle 1
  of the same standard — migrating to a Node-only runner would violate it).
- Browser/e2e/load (`e2e/*.spec.ts`, `bun x playwright test`): stays
  @playwright/test, already the ONE e2e framework fleet-wide.

## What the deviation still requires (gate-shaped, not surrender)

1. **Two-tier law, no third framework**: new unit tests use bun:test; new
   browser/e2e/load tests use @playwright/test. Enforceable as a law guard
   (imports of neither `bun:test` nor `@playwright/test` in `*.test.ts` /
   `e2e/*.spec.ts` are refused).
2. **Structural split stays sharp**: bun:test files live in `test/` or
   `*.test.ts`; PW specs live in `e2e/` + `*.spec.ts` naming. Drift stays
   grep-detectable, so the census can be re-run any time.
3. **Load**: the standard's "same specs rerun as load" is adoptable exactly
   where PW applies — a PW load project re-running the e2e specs with timing
   assertions. Recommended follow-up; not minted here (no invented work).

## Alternatives considered

- **Full migration to @playwright/test**: infeasible without abandoning
  Bun-native code or the Bun runtime (probes A/B); violates native-first +
  the automation doctrine. Rejected.
- **PW runner on Node + Bun-compat shim**: no shim exists for `bun:sqlite` /
  `Bun.serve` semantics; PW's Bun support is unofficial (probe B). Rejected.
- **Record the deviation** (chosen): keeps exactly two frameworks by layer,
  preserves Bun-native testing, costs one doc + an optional law guard.

## Related tracked work (the compliant path under this decision)

- W1135.1.3 test-kit foundation (bun:test-side DRY: scratchWorld, runCli,
  freePort/waitUp, serveStub) — rides bun:test, unaffected.
- W1135.1.4/.5 kit migration (belt + buckle suites) — unaffected.
- W1135.1.6 e2e collapse onto one shared board harness — IS the PW-side
  consolidation this decision names.
