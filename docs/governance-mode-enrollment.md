# Governance-mode enrollment — W422.17 close-out record

Owner directive (2026-10-05): **ALL** CLIs and **ALL** agents ride buckle keys +
suspenders governance — no belt-direct fallback in fleet posture. This record
closes the parent item; each numbered scope part cites its landing.

## 1. Mode as fleet state

- Mode (`all` | `mixed`) is stored as the coord fact `fleet.governance` —
  not a config file, not code: the knowledge plane is the single source.
- The `/fleet` project command reads the mode and can switch it
  (`coord governance strict|solo`; no argument = read-only pulse).
- SessionStart renders the current mode into every session's rules, so
  lanes learn their posture at boot without re-deriving it.

## 2. Interactive-session enrollment (child W422.17.1 @1044cae)

Session bootstrap mints a per-session `bksk_` key through the buckle admin
API and injects `ANTHROPIC_BASE_URL` (the buckle front) via the per-lane
0600 `--settings` mechanism, generalized to interactive sessions. Live
proof: session banners now render
`GOVERNANCE: enrolled — session rides the buckle front /w/<sid> (scoped key, ttl 86400s)`.

## 3. CLI enrollment matrix (child W422.17.2 @32b80b8)

| CLI          | Wire            | Status                                 |
| ------------ | --------------- | -------------------------------------- |
| claude lanes | buckle front    | done                                   |
| codex        | :4100 responses | done                                   |
| copilot      | openai-wire     | done                                   |
| copilot      | anthropic-wire  | FAIL → fixed (benchmarks.md row green) |

## 4. Belt/board internal calls (child W422.17.3 @0e64206)

belt and board internal LLM calls are enrolled behind buckle keys — no
component in the stack talks to an upstream without a minted, scoped,
revocable key.

## Fail-closed proven in production (2026-10-11)

The buckle-spoke crash-loop (generation-scoped plist path, lesson.buckle-spoke-plist-generation)
made the front unreachable; `governance:strict` refused every dispatch
fail-closed across ~95 READY candidates until the probe passed again. The
refusal — not a silent belt-direct fallback — is the designed behavior, and
it held.

## Related

- W607 @0815b65 — bksk_-authed MCP fleet read surfaces for chat GUIs
  (`/v1/fleet/whoami` self-verify on buckle).
- W615 — per-lane cost attribution in the buckle ledger (the audit leg of
  enrollment).
