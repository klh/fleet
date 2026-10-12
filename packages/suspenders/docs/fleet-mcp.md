# fleet-mcp — the fleet MCP server for chat GUIs (W607)

Desktop chat apps have no repo/hooks context — GUI "fleet awareness" used to
be the owner relaying pings by hand. `hooks/bin/fleet-mcp.ts` is a small MCP
server that gives Claude desktop / ChatGPT desktop (developer mode) / any
MCP client live fleet eyes: six READ surfaces off the live governor.db.

## Surfaces

| tool                 | answers                                                |
| -------------------- | ------------------------------------------------------ |
| `fleet_work_ready`   | claimable work (exact `work ready` parity, deps-met)   |
| `fleet_work_list`    | items, open (default) or all states                    |
| `fleet_work_show`    | one item in full: state, owner, description, deps      |
| `fleet_coord_fleet`  | who is working: lanes + live states + claim intents    |
| `fleet_coord_fact`   | fleet knowledge: get by exact key, list by prefix      |
| `fleet_coord_metrics`| runs, throughput, medians, token usage (`coord metrics`)|

## Auth — the GUI key rides the buckle plane

The server refuses everything without a live fleet-read key: a `bksk_` key
minted via the buckle admin API with scope **`buckle:proxy:READ_`**, verified
per call against `GET /v1/fleet/whoami` on the buckle front (30s cache, so
revocation lands within one cache window). 401 → unknown/expired/revoked;
403 → valid key, wrong scope; network miss → deny (fail-closed, like
dispatch). Mint/revoke/verify all land in buckle's auth ledger, and every
tool call appends a 0600 JSONL row to
`~/.claude-insights/fleet-mcp-audit.jsonl` (ts, tool, key_id, ok, ms).

Mint (from the belt.env admin — same plane as lanes):

```sh
curl -s http://127.0.0.1:4101/v1/admin/keys \
  -H "authorization: Bearer $BUCKLE_ADMIN_KEY" \
  -d '{"name":"claude-desktop","scopes":["buckle:proxy:READ_"]}'
```

Revoke = `POST /v1/admin/keys/<key_id>/revoke` — the GUI loses fleet access
within one cache window. Test keys get revoked, never left behind.

## Attach — Claude desktop

`~/.claude.json` (or the desktop app's connector UI → manual config):

```json
{
  "mcpServers": {
    "fleet": {
      "command": "bun",
      "args": ["~/.claude/hooks/suspenders/bin/fleet-mcp.ts"],
      "env": {
        "FLEET_MCP_KEY": "bksk_…",
        "FLEET_MCP_PROJECT": "/Volumes/Sensitive/github/klh/fleet"
      }
    }
  }
}
```

- `FLEET_MCP_PROJECT` is required for desktop GUIs (they spawn at `/`); any
  checkout or worktree path works — it canonicalizes to the repo identity
  via projectIdentity. Without it the server scopes to the cwd identity.
- `FLEET_MCP_KEY_FILE` (0600 file) replaces `FLEET_MCP_KEY` if you prefer
  the key out of the JSON.
- `SUSPENDERS_BUCKLE_FRONT` overrides the buckle front
  (default `http://127.0.0.1:4101`).
- After `bash install.sh` (the only repo→prefix sync), the binary lives at
  `~/.claude/hooks/suspenders/bin/fleet-mcp.ts`. Until the next install,
  point `args` at a checkout path instead.

Then ask: *"what is READY?"* — the connector answers from the live graph.

## Attach — ChatGPT desktop (developer mode)

ChatGPT fetches connectors server-side: a localhost URL will not resolve.
Run the stateless HTTP face and front it with a real host:

```sh
bun ~/.claude/hooks/suspenders/bin/fleet-mcp.ts --http 7801
```

`POST /mcp` (JSON-RPC, Bearer fleet key), `GET /health` plain. Put it behind
belt.local/Caddy for a reachable URL, register the connector, done. (ChatGPT
traffic itself stays on its pinned vendor endpoints — only the fleet-access
leg rides buckle.)

## Tests

`bun test packages/suspenders/test/fleet-mcp.test.ts` — spawns the real
server over stdio + the `--http` face against a seeded scratch governor.db
and a stubbed whoami plane: handshake, six-tool surface, deps-met READY
filtering, 401 refusal, facts, HTTP MCP.
