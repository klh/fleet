# belt MCP server — Streamable HTTP + Entra ID

W260: belt exposes the fleet knowledge store and belt-routed inference as an
MCP (Model Context Protocol) server over Streamable HTTP, so any MCP client
— and Microsoft Copilot Studio via the MCP Toolkit — can register it as an
action.

- **Endpoint**: `http://<host>:7793/mcp` (BELT_MCP_PORT)
- **Transport**: Streamable HTTP — JSON-RPC 2.0 on POST /mcp; GET → 405 (no
  server-initiated stream); DELETE → 204 (session end); JSON responses (SSE
  wrapping when the client accepts only text/event-stream)
- **Auth**: Entra ID JWT bearer (RS256 via the tenant JWKS). Tools run only
  behind a verified token. Dev posture: `BELT_MCP_DEV=1` = loopback-only +
  open — for local client development, never LAN-exposed.
- **Health**: `GET /health` — process liveness (the outside-process probe
  law still applies for hub deploys: point a *-health sidecar at it).
- **Tools**:
  - `knowledge_search` — ranked FTS5 retrieval over the fleet knowledge
    layer (knowledge.db cards, governor.db facts + consult_kb). Output cards
    carry state/age/ref trust markers; the preamble tells remote consumers
    hits are leads, not settled truth.
  - `belt_infer` — one-shot completion via the belt router
    (`BELT_ROUTER_URL`, default :4000, Anthropic wire). Each call
    independent; the complexity router picks the model.

## Config (machine-level, never the repo)

`~/.claude/local-llm/belt-mcp.env` (mode 600), loaded at boot; process env
wins:

```sh
BELT_MCP_PORT=7793
BELT_MCP_BIND=127.0.0.1          # 0.0.0.0 only behind a front that terminates auth
BELT_MCP_TENANT=<entra-tenant-guid>
BELT_MCP_AUDIENCE=<api-app-client-id>
BELT_MCP_REQUIRED_SCOPE=access_as_user   # optional; empty = any valid token
BELT_MCP_HOSTS=belt-mcp.local            # extra Host spellings through the guard
BELT_ROUTER_URL=http://127.0.0.1:4000
```

Without tenant+audience the server binds to loopback in status-only mode:
`/` explains setup, while `/health` and `/mcp` return 503 and no tools run.
`BELT_MCP_DEV=1` pins loopback and opens the tools for local development.

## Entra setup (runbook, placeholders only)

1. **API app** — Entra admin center → App registrations → New:
   - name `belt-mcp-api`; note the Application (client) ID + Directory
     (tenant) ID → these are `BELT_MCP_AUDIENCE` / `BELT_MCP_TENANT`.
   - Expose an API → Set Application ID URI (`api://belt-mcp`) → Add scope
     (e.g. `access_as_user`); admin-consent it for the tenant.
2. **Client app** (the connector's identity): new registration, note its
   client ID; API permissions → the `api://belt-mcp` scope above. For a
   confidential client add a certificate or secret (Copilot Studio
   connector security config).
3. Tokens reach the server as `Authorization: Bearer <jwt>` with
   `aud = BELT_MCP_AUDIENCE`, issuer
   `https://login.microsoftonline.com/<tenant>/v2.0` (v1
   `sts.windows.net` issuers also accepted), signed by the tenant JWKS.

## Copilot Studio registration (MCP Toolkit)

Prereq: the endpoint must be reachable from Microsoft's cloud — expose the
server through a TLS reverse proxy or tunnel on a public hostname; the
`.local` Caddy front serves LAN clients only (host guard: add that hostname
to `BELT_MCP_HOSTS`). Then:

1. Power Apps custom connector: New → Import "MCP" (the MCP Toolkit
   template). Host = your public hostname, Base URL `/`.
2. Security: OAuth 2.0 (Entra ID) with the **client app** id/secret, token
   URL `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`,
   scope = the `api://belt-mcp` scope.
3. Import the connector; Copilot Studio reads `tools/list` at design time —
   knowledge_search + belt_infer surface as agent actions.
4. Add the connector as an **Action** in your Copilot Studio agent
   (Tools → Add tool → connector-based), then test in the agent's test pane.
5. `tools/list` changes require connector refresh (MCP Toolkit re-lists on
   update).

## Verify (loopback, dev mode)

```sh
BELT_MCP_DEV=1 bun bin/mcp-server.ts &
curl -s 127.0.0.1:7793/health
curl -s 127.0.0.1:7793/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s 127.0.0.1:7793/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s 127.0.0.1:7793/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"knowledge_search","arguments":{"query":"launchd plist wiring"}}}'
```

## Install

`bash install.sh --with-launchd` from packages/belt syncs bin/* to the
runtime home and loads `com.belt.mcp` (launchd template in launchd/); the
klh-local block registers `belt-mcp.local` on the Caddy front when
klh/local + caddy are present.
