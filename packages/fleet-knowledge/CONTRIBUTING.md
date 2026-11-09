# Contributing to fleet-knowledge

Small, focused contributions are welcome. This document is the contributor
contract; `AGENTS.md` is the same contract for agent contributors.

## Development setup

[Bun](https://bun.sh) 1.2 or newer. No other system dependencies.

```bash
bun install          # dependencies
bun run typecheck    # tsc --noEmit
bun test ./test/     # the test suite
bunx @biomejs/biome check src bin test   # lint
```

`make help` wraps the same targets. `docker-compose.yml` runs the sink plus
its health sidecar locally; `.env.example` documents every env knob the code
reads.

## Gates

A change is done when all three are green:

1. `bun run typecheck`
2. `bun test ./test/`
3. `bunx @biomejs/biome check src bin test` (run `make fmt` to auto-fix)

Run them locally before pushing — CI runs exactly these.

## Commit style

- Imperative subject line: "add row caps to the sql face", not "added ...".
- Keep one logical change per commit.
- `Co-Authored-By: Claude Code <noreply@anthropic.com>` is optional
  attribution and welcome on agent-authored commits.
- No tags.

## Pull requests

1. Branch from `main`.
2. Add or extend tests for new behaviour; the suite must stay green.
3. One logical change per PR. If it grew two, split it.
4. New env knobs land **with** their `.env.example` row in the same change —
   an undocumented knob is a defect.
5. Describe the why, not just the what, in the PR body.

DCO sign-off is not required.

## Security

Never report vulnerabilities through public issues or PRs — see
[SECURITY.md](SECURITY.md) for the private advisory path.
