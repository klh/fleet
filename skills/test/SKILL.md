---
name: test
description: Use when implementing features or fixing bugs test-first (TDD); for bugs use the Prove-It pattern. Fire before writing implementation code; not for merely running an existing suite or one-off REPL checks.
---

Invoke the test-driven-development skill. For Jest work, also use klh-testing-patterns.

For new features:

1. Write tests that describe the expected behavior (they should FAIL)
2. Implement the code to make them pass
3. Refactor while keeping tests green

For bug fixes (Prove-It pattern):

1. Write a test that reproduces the bug (must FAIL)
2. Confirm the test fails
3. Implement the fix — root cause only, no drive-by refactors
4. Confirm the test passes
5. Run the full test suite for regressions (`npm test` / `dotnet test` — both allowlisted, no prompts)

For browser-related issues, use the browser-testing-with-devtools skill with the chrome-devtools MCP. Evidence before assertions: attach real command output when declaring anything green.

## Gotchas

- Spawn-heavy suites need a file-level `setDefaultTimeout` (bun:test) — and async `describe` wrappers drop the timeout silently; set both or neither.
- Copied `/bin/sleep` fixtures die as fake zombies (liveness red with zero delta) — spawn the real binary or a bun-native sleeper.
- In-process hub wire tests hang on this macOS (spawned child → parent loopback) — probe by importing the real functions in-process instead.
- A/B against the branch baseline before claiming a failure (~52 pre-existing fails in the suspenders suite); a flaky spec re-runs solo before triage.
