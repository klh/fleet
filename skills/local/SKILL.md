---
name: local
description: Use when the operator asks for local-only LLM mode — swarm only, zero cloud, no silent escalation, for this session and the router config. Not for restoring cloud afterwards (that is the cloud skill).
---

Activate local-only mode. Do each step, in order:

1. Run `bun ~/.claude/local-llm/set-cloud.ts off` — this sets the router's
   `allow_cloud = false` so :4000 will never escalate to z.ai.
2. Run `bun ~/.claude/local-llm/set-cloud.ts status` and confirm it prints
   `false (local-only)`.
3. For the rest of this session:
   - Route all LLM inference to the local swarm: `http://127.0.0.1:4000`
     (Anthropic-compatible router) or direct ports — 8901 code · 8902
     extract · 8903 reason · 8906 danish/general · 8907 embed · 8912
     kev (typed classifier) · 8913 rerank.
   - NEVER call cloud LLM services (z.ai, GLM, or any remote model API) —
     not for inference, not as a fallback, not "just this once". The router
     will not escalate; do not bypass it by calling cloud endpoints directly.
   - If a task genuinely exceeds local model capability, STOP and tell me —
     do not escalate on your own.

## Gotchas

- Direct :890x tiers 404 model ALIASES — the wire id is the live `/v1/models` id, not the friendly name.
- Unprivileged binds of ports <1024 on 127.0.0.1/::1 fail EACCES on macOS — probe ports above the privileged range.
- An empty-string env override counts as set (`ORACLE_ROUTE_MODEL=""` once 400'd the whole :8903 pool to k=1) — trim-guard operator knobs before trusting a fallback.
