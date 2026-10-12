# belt · M365 custom-engine agent (W261)

belt exposes the fleet's LLM gateway as a **Microsoft 365 custom engine
agent**: M365 Copilot (or any Bot Framework client) POSTs an Activity to
belt's endpoint, belt grounds the question in the calling user's M365
content via the **Graph Retrieval API** with **delegated Entra ID** tokens
(device-code flow, no client secrets, tokens cached 0600), routes the
completion through belt's Anthropic seam (:4000 shim), and replies with an
Activity.

```
M365 Copilot ──Activity──▶ belt /api/m365/agent
                             │ verify caller (Entra JWKS, RS256)   ← M365_AGENT_VALIDATE=1
                             ├ ground: Graph /copilot/retrieval    ← delegated token (0600 cache)
                             └ complete: :4000 /v1/messages        ← M365_COMPLETIONS_URL
```

## Modules

| File | Role |
| --- | --- |
| `bin/m365/entra-auth.ts` | device-code flow + 0600 token cache + refresh |
| `bin/m365/retrieval.ts` | Graph Retrieval client, defensive hit normalization |
| `bin/m365/agent-endpoint.ts` | Activity handler, JWKS caller validation, HTTP skin, default wiring |
| `bin/m365/login.ts` | owner login CLI (`--status`, `--logout`) |
| `bin/m365/serve.ts` | standalone endpoint, `--port 4180` |
| `test/w261-m365-agent.test.ts` | 19 stub-server tests (no live tenant) |

## Env contract (config-over-code: real values in machine env only)

| Var | Meaning | Default |
| --- | --- | (none — inert without it) |
| `M365_TENANT_ID` / `M365_CLIENT_ID` | Entra app registration (public client) | none — module inert |
| `M365_AUTHORITY` | authority base | `https://login.microsoftonline.com` |
| `M365_GRAPH_SCOPES` | delegated scopes (space-separated) | `User.Read offline_access` |
| `M365_TOKEN_CACHE` | token cache file (0600) | `~/.claude/local-llm/m365-tokens.json` |
| `M365_RETRIEVAL_DATA_SOURCE` | grounding source | `sharePoint` |
| `M365_GRAPH_BASE` / `M365_GRAPH_API_VERSION` | graph endpoint | `https://graph.microsoft.com` / `beta` |
| `M365_AGENT_VALIDATE` | enforce JWKS caller validation | off |
| `M365_COMPLETIONS_URL` / `M365_COMPLETIONS_KEY` / `M365_AGENT_MODEL` | completion upstream | `:4000 /v1/messages` / empty / `auto` |
| `M365_AGENT_MAX_GROUND_CHARS` | grounding block cap | `6000` |

Default env home: the belt env file (`~/.claude/local-llm/belt.env`, 0600)
— add the M365_* block there, never in-repo.

## Activation runbook (needs the real tenant, owner present)

1. **Entra app registration** — single-tenant, **public client**, **Allow
   public client flows = Yes** (device-code), redirect `http://localhost`.
2. **API permissions (delegated)**: `User.Read`, `Files.Read.All`,
   `Sites.Read.All`, `Mail.Read` — see the verify-pending note below.
3. Admin-consent the delegated scopes for the tenant.
4. `M365_TENANT_ID` + `M365_CLIENT_ID` into `~/.claude/local-llm/belt.env`.
5. `bun packages/belt/bin/m365/login.ts` — enter the device code in a
   browser (owner seat).
6. Smoke: `bun bin/m365/serve.ts --port 4180` + POST an Activity; expect
   grounded text, not the login hint.
7. Only then: `M365_AGENT_VALIDATE=1` + Teams manifest
   (`copilotAgents.customEngineAgents`) pointing at the belt endpoint, and
   a launchd plist (`com.suspenders.belt-m365`) — plist/manifest are
   activation-time artifacts, minted against real values, not committed.

## Verified vs verify-pending

**Verified by stub tests + live local smoke (this repo):** device-code
begin/poll/approve, 0600 cache + refresh rotation, refresh-death →
login-needed, retrieval client contract + normalization (canonical and
legacy field names), 401 → login-needed mapping, Activity handling
(non-message, empty, grounded reply, failure degradation), JWKS RS256
caller validation (positive + negative), completion upstream join.

**Verify-pending against the live tenant (first activation):**

- Retrieval API request/response field names — encoded ONLY in
  `retrievalRequestBody()` / `normalizeHits()`; adjust there if the tenant
  reports drift. Docs-of-record: Microsoft Graph "Use the Graph Retrieval
  API" (learn.microsoft.com), `/beta` surface.
- Delegated scope set above (retrieval needs more than `User.Read`; exact
  names are tenant/preview-dependent).
- Bot Framework "Direct to engine" auth audience expectations for the
  incoming token (`aud` = app id is the common case; confirm on first
  real Copilot request).
