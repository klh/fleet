---
name: cloud
description: Use when the operator ends local-only mode and cloud escalation must be restored through :4000 (never in cost mode). Not while set-cloud status still reports local-only, and not for switching to local-only — that is the local skill.
---

Run `bun ~/.claude/local-llm/set-cloud.ts on`, then confirm with
`bun ~/.claude/local-llm/set-cloud.ts status`. Cloud escalation is available
again for COMPLEX+ requests through :4000 (never in cost mode).

## Gotchas

- An empty-string env knob counts as set: `env.X ?? fallback` passes on `""` — `ORACLE_ROUTE_MODEL=""` once 400'd the whole :8903 pool. Trim-guard operator knobs.
- `process.env.X = undefined` stores the literal string `"undefined"` in Bun — guard with `delete` or explicit checks, not truthiness.
- User settings.json `env` merges OVER process env, so a stale `ANTHROPIC_*` in settings silently wins over what a script exported.
