# Decision — desktop hub real upstream ladder (W688.7.1)

Materializes mission item (2): the desktop hub rode the committed
placeholder ladder (dead `api.anthropic.com` legs), so the buckle-ready
sidecar 502'd on the synthetic completion and no hub model had a live leg.

## What changed (machine config only — config-over-code)

`~/.config/klh/stack.yaml` desktop profile (backup:
`stack.yaml.bak-w688-7-1`):

- `ready_model: general` — names the model the buckle-ready sidecar's
  synthetic call asks for (compose default `general` was unrouted).
- `upstreams.groups` — hub ladder legs over the host chain (hub compose
  runs `network_mode: host`, so loopback is the host and the egress law
  admits it by default; no `http_upstream_hosts` needed):
  - `general`, `glm-5.3-flash` → litellm `:4100` openai-compat
    `zai-glm-5.3-flash` (`api_key_env: LITELLM_KEY`)
  - `local-swarm` → host MLX swarm `:8902` openai-compat
  - `claude-sonnet-5` → litellm `:4100` anthropic dialect
    `zai-glm-5.3-flash` — mirrors the machine `upstreams.yaml` claude-*
    alias ladder (Copilot→glm fallback while the seat is quota-walled)
- `secrets.upstream_keys: LITELLM_KEY → ~/.claude/local-llm/litellm.key`
  — 0600 raw-value file minted on-device; `hubctl push` builds the hub's
  `upstream.env` from it (W688.7.1 seam in `deploy/hubctl.ts`).

Overlay posture untouched: the running hub already served the enterprise
overlay (`/federation/entitlements` 200 before this change), so pending
decision #46314's tag-publish half was moot — only the config + deploy
half executed.

## Verification (2026-10-19)

- `hubctl deploy desktop` → mint/push/up green
- `hubctl status desktop` → **all healthy**, incl. `buckle-ready
  :4113/healthz → 200` (was 502)
- `POST /v1/chat/completions` model `general` → 200
  (`zai-glm-5.3-flash` leg)
- `GET /federation/entitlements` → 200, 8 models (non-501)
