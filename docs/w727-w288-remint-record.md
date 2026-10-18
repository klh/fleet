# W727 — W288 re-mint: verified landed (record)

W727 re-mints W288 (the original row FAILED in the work graph — there is
no reopen verb). The mission's substance already landed in main as
e66a4bde (2026-10-15, "W288: enhance target -> belt direct tier by
registry alias", merged 46328e33), so W727 closes as the verification
record, not a re-do.

## What landed (e66a4bde, ancestor of main @ b70ab6ea)

- `packages/suspenders/hooks/board/prompt-transform.ts` — the enhance
  target resolves once per call from belt's EMITTED `direct-tiers.json`
  (the gateway-config emission, never a YAML re-parse), loopback-validated,
  alias preference `local-extract` → `local-reason`; OpenAI wire, no
  complexity router — the goal text cannot escalate off-box. Operator pins
  `SUSPENDERS_PROMPT_ENHANCE_URL` / `_MODEL` / `_KEY` keep gateway mode
  (buckle front, Anthropic wire).
- The REAL serving model is recorded: the resolver live-probes
  `/v1/models` on the specialist (3 s timeout) — the alias is the policy
  key, the probed id is what rides the wire and what `EnhanceTarget.model`
  / `EnhanceResult.model` record (lesson `direct-tier-wire-id-not-alias`:
  the :890x specialists 404 the alias as body model).
- Board wiring: `orch.ts:164` `resolveEnhanceTarget` → `enhancePrompt`.
- Tests: `packages/suspenders/test/prompt-transform.test.ts` — "enhancePrompt
  (openai wire, W288)" + "enhance target resolution (W288)".

## Verification (2026-10-18, worktree @ b70ab6ea)

- 32/32 `prompt-transform.test.ts` pass.
- Live `resolveEnhanceTarget()`: `{"mode":"direct","alias":"local-extract",
  "model":"mlx-community/Qwen3-4B-Instruct-2507-4bit",
  "url":"http://127.0.0.1:8902/v1/chat/completions","wire":"openai"}`.
- Live enhance call on that target: ok=true, note="enhanced", model
  recorded as above, 920 ms.

## Notes

- The original W288 row stays FAILED; this record + the W727 closure are
  the graph's memory of the work.
- Observation (out of scope): the live enhance output invented a
  plausible-looking auth URL absent from the input — enhance output
  quality is a separate concern from target resolution.
