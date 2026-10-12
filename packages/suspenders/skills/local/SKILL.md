---
name: local
description: Local-only LLM mode — swarm only, zero cloud, no silent escalation
---

Activate local-only mode. Do each step, in order:

1. Run `bun ~/.claude/local-llm/set-cloud.ts off` — this sets the router's
   `allow_cloud = false` so :4000 will never escalate to z.ai.
2. Run `bun ~/.claude/local-llm/set-cloud.ts status` and confirm it prints
   `false (local-only)`.
3. For the rest of this session:
   - Route all LLM inference to the local swarm: `http://127.0.0.1:4000`
     (Anthropic-compatible router) or direct ports — 8901 code · 8902
     extract/simple · 8903 reason/architecture · 8912 classifier.
   - NEVER call cloud LLM services (z.ai, GLM, or any remote model API) —
     not for inference, not as a fallback, not "just this once". The router
     will not escalate; do not bypass it by calling cloud endpoints directly.
   - If a task genuinely exceeds local model capability, STOP and tell me —
     do not escalate on your own.
