# AGENTS.md — test-kit

Shared test primitives for the fleet monorepo (W1135.1.3): exactly four,
each the verbatim semantics of the audited best-in-repo idiom. New tests
MUST use the kit — no new hand-rolled mkdtemp/spawn/port/stub helpers.
Existing suites migrate in W1135.1.4/.1.5 (this package ships with its own
green suite and zero caller migration).

## The four primitives

- `scratchWorld(opts?)` — scratch HOME + git-init'ed repo (real `git init`
  + baseline commit, per the work-cli.test.ts gitInit idiom) + env spread
  pinning `HOME`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` into the scratch
  home and `GOVERNOR_STORE_URL=local`; `world.clean()` = rmSync teardown.
  Import: `@klh/test-kit` (workspace dep) or `../src/...` inside the kit.
- `runCli(bin, args?, opts?)` — `["bun", bin, ...args]` spawnSync →
  `{code, out, err}` with cwd/env overrides (env spread over process.env).
- `freePort()` / `waitUp(url, opts?)` — Bun.serve `port: 0` reservation +
  100x100ms readiness poll (500ms per-attempt abort; throws after the last
  try; `tries`/`intervalMs` overridable).
- `serveStub(handler?, opts?)` — Bun.serve stub upstream on a scratch
  loopback port: `requests` array (path/body/auth/headers/n) recorded
  before the handler answers; default handler answers 200 "ok".

## Law

- The kit is the ONE source for these four idioms — when a suite needs one,
  import it; when the idiom itself must change, change it HERE with its
  unit tests, never per-file.
- No production deps: node/bun stdlib only. The kit must stay loadable from
  every package's test tier.
