# W2280 — rebase suspenders/W1266 onto main (merge ladder conflict)

## Decision

`parked/W1266` (tip `aee1730a`) is merged into `suspenders/W2280` with every
conflict resolved to **main's side**. The resulting tree is byte-identical to
the main tip the lane started from (`535a2c0a`) — the merge contributes pure
**ancestry**, which is exactly what the merge ladder needs to stop refusing
the branch (`review context: git merge-tree failed`).

## Why main's side everywhere

`git cherry main parked/W1266` flags 3 patch-unequal commits; every one's
content is already on main in evolved form:

- `19999f05` *deterministic Coding Plan concurrency regressions* — the test
  file exists on main (`623d6228`), evolved past the branch's copy by the
  W1257 evidence-word law and the AIMD expectations matching main's router
  runtime (rateLimitedTotal 6 / adaptiveConcurrency < 6 vs the branch's
  older 16/6 shape).
- `553b83c8` *reusable opt-in capacity-ramp CLI* — `capacity-ramp.ts` is on
  main (`7dd74195`).
- `aee1730a` *resolve committed W1265 merge markers* — all three of its
  fixes landed on main independently:
  - server.ts `dbPath`: main's W1246 `defaultDbPath()` runtime-home
    resolution (server.ts:88-91, used at :316).
  - handlers.ts duplicate `errorResponse` + `scrubText` double-import: the
    W1297 decomposition dissolved the monolith into siblings; exactly one
    `errorResponse` definition remains (error-response.ts:11), consumers
    import it, and no src file double-imports `scrubText`.
  - test JSON-config retarget: main's test already writes `.json` configs.

Re-applying the branch's side would revert main's later evolution — the
opposite of a rebase.

## Resolution detail

- Content conflicts (handlers.ts, coding-plan-concurrency.test.ts):
  `git checkout --ours` = main.
- server.ts auto-merged coherently (its region already matches main's
  `defaultDbPath()` line; the touched suite exercises it end to end).

## Evidence

- `git diff --cached --stat HEAD` after staging the resolution: **empty** —
  the merged tree is byte-identical to the base tip.
- Touched suite `packages/buckle/test/coding-plan-concurrency.test.ts` via
  `cd packages/buckle && bun test ./test/coding-plan-concurrency.test.ts`:
  3 pass / 2 fail, deterministic across two runs. Both fails are base-tip
  fails **by construction**: the merged code tree is byte-identical to
  `535a2c0a`, so the merge introduces nothing (the same structural argument
  W2204 recorded for its law-guard fail set). Fails: `50 concurrent
  upstream forwards` (502 vs 200) and `1302 classification is data`
  (concurrencyLimitedTotal 1 vs 16).
