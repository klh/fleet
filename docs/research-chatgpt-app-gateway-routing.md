# ChatGPT.app macOS gateway routing — feasibility research (W1231)

Research date: **2026-10-23**. Item: W1231 (tags `fleet,routing,gateway`).
Deliverable is REPORT-ONLY: a feasibility verdict + recommendation. No MITM
implementation without explicit owner word.

## Question

Can ChatGPT.app (the macOS desktop client) route its inference through buckle
(the fleet LLM gateway) the way API-key clients do?

## Verdict

**Not routable cleanly.** ChatGPT.app is an account-session product on the
chatgpt.com wire, not an API-key client. Buckle fronts **keys**; ChatGPT.app
offers no place to put a buckle key and no custom base-URL setting. The only
mechanical route is a chatgpt.com reverse proxy (TLS-terminating MITM + custom
CA + cert-pinning subversion) — fragile against app updates, pinning/attestation
risk, ToS-gray. Per owner law: **no silent MITM; no implementation without an
explicit owner word.**

## Recorded findings (item W1231, web research 2026-10-23)

- ChatGPT.app has **no in-app custom base URL** setting.
- It authenticates as an **account session** (chatgpt.com backend wire), not by
  API key — buckle fronts keys, and there is no key to front.
- Closest legitimate pattern: the **codex-proxy** bridge (Responses API →
  OpenAI-compatible) for Codex Desktop, and `openai_base_url` in Codex CLI
  config.

## Local corroboration (this machine, 2026-10-23)

- ChatGPT.app is installed and was running at research time (`pgrep -x ChatGPT`).
- Codex CLI is installed (`/opt/homebrew/bin/codex`) — the supported-seam
  pattern applies to a surface that exists on this machine.

## What the stack already has (repo evidence)

- `packages/buckle/src/handlers.ts:1378-1466` — buckle **already serves the
  OpenAI Responses wire** (`POST /v1/responses`) alongside
  `/v1/chat/completions` and `/v1/messages`.
- `packages/buckle/src/chatgpt-bridge.ts` — the **opposite direction**: buckle
  pulls ChatGPT subscription accounts IN as upstreams over the chatgpt.com
  Responses wire, with typed instruction-plan normalize/refuse rungs (the
  W1124.27 refuse-before-fetch rung landed on main). That is the legitimate
  ChatGPT integration seam: buckle as client INTO chatgpt.com, never
  ChatGPT.app as client THROUGH buckle.
- `packages/belt` — config-driven ChatGPT subscription model rows
  (commits 627c2d84, 7900643b) already model the subscription upstream.

## Options (decision-grade)

| Option | Mechanism | Verdict | Why |
| :----- | :-------- | :------ | :-- |
| 1. In-app base URL | ChatGPT.app setting | **Infeasible** | No such setting exists |
| 2. chatgpt.com reverse proxy | TLS MITM + custom CA, DNS/hosts override | **Reject** | Pinning/attestation risk, breaks on app updates, ToS-gray; banned without explicit owner word |
| 3. Codex CLI/Desktop → buckle | Codex `openai_base_url` / provider `base_url` config → buckle `POST /v1/responses` | **Feasible now** | Both ends exist today; config-supported, no MITM |

## Recommendation

If the goal is a ChatGPT-like desktop surface riding fleet models, use the
supported seam: point Codex CLI/Desktop at buckle (`/v1/responses`), which the
gateway already serves. ChatGPT.app itself stays on its account-session wire;
the fleet's ChatGPT presence rides buckle → chatgpt.com as upstream (already
landed). Any reverse-proxy experiment is owner-word territory only.
