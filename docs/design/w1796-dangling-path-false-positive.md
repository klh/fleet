# W1796 — dangling-path false positive: packages/suspenders/scripts/supervisor.ts

## Finding

The item alleged merge 85576d93 dropped
`packages/suspenders/scripts/supervisor.ts`, referenced by
`packages/suspenders/scripts/install-llm-steps.ts` via `./supervisor.ts`.

No repair is needed:

- `git log --all -- packages/suspenders/scripts/supervisor.ts` is empty —
  the file never existed in repo history, so the merge dropped nothing.
- `install-llm-steps.ts` contains no import of that path. The only
  occurrence of `./supervisor.ts` (line 595) is a string literal inside a
  content assertion:
  `if (!swarmSource.includes('from "./supervisor.ts"'))` — it validates that
  a seeded `swarm.ts` runtime copy carries the supervisor import, against
  the belt family, where `packages/belt/bin/supervisor.ts` exists.
- Import probe: `await import("./packages/suspenders/scripts/install-llm-steps.ts")`
  resolves cleanly (9 exports).

## Disposition

Scanner false positive: a substring content check was read as a relative
import. No path restored, no reference rewritten, item closed without code
change.
