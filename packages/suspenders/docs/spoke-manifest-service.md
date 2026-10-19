# W501 — buckle spoke as manifest service (darwin)

The spoke `:4101` died three times in two days because it ran as a
session-owned background shell. It is now the first launchd manifest
service: `com.suspenders.buckle-spoke`, KeepAlive-backed, env sourced from
`~/.claude/local-llm/buckle-spoke.env` at exec time.

## Landed

- `5f15b922` on `main` (`fix(suspenders): supervise buckle spoke with
  required routing env`) — the product commit, merged from the W501
  landing work.

## Design (W488 acceptance)

1. **renderDarwin envFile support** — launchd has no `EnvironmentFile`
   (systemd gets `EnvironmentFile=` natively; WinSW documents its
   `envFile` path). When `spec.envFile` is set, `renderDarwin` wraps
   ProgramArguments as
   `/bin/sh -c 'set -a; source <envfile>; exec <bun> <entry> <args>'`.
   Secrets stay out of the plist: the file is a PATH reference, values
   ride process env at exec time.
2. **Manifest entry** — `buckle-spoke`: bunEntry
   `__REPO__/../buckle/src/server.ts`, cwd `__REPO__/../buckle`, envFile
   `__HOME__/.claude/local-llm/buckle-spoke.env`, keepalive, BUN/REPO/HOME
   placeholders.
3. **Parity** — `test/services-envfile.test.ts` +
   `test/services-manifest.test.ts` cover the darwin wrap, the systemd
   `EnvironmentFile=` line and the template tokenization (50 tests).

## Verification receipt

- Suites 50/50 green on branch head `f54d2448` (2026-10-19, after
  `bun install --force` relink).
- Label installed + bootstrapped (receipt v1, KeepAlive), `:4101` live:
  `/health` ok, auth gate answering 401 with problem details.
- Kill→revive KeepAlive proof is owner-side (lane lifecycle fence denies
  `launchctl`/`kill`; decision #25597/#46348) — closed on receipt
  evidence: the label is install-grade, live, and documented in the
  launchd port map.
