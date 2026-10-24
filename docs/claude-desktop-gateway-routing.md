# Claude Desktop (macOS) inference through buckle — W1230

Verified **2026-10-23** against the live buckle spoke (`:4101`, Mac spoke).
Item: W1230 (tags `fleet,routing,gateway`). Conclusion: Claude Desktop's
official third-party inference gateway rides buckle today — every wire
requirement passed live verification, and the only remaining step is a
one-time paste in the Desktop GUI.

## Verdict

**Routable now.** Claude Desktop exposes the supported seam (Settings →
Developer → Configure Third-Party Inference, `provider=gateway`). Buckle
already serves everything that seam needs on the anthropic dialect:

| Desktop requirement | Buckle evidence (live, :4101) |
| :--- | :--- |
| `POST /v1/messages`, streaming | 200 `text/event-stream`, full ladder `message_start → deltas → message_delta → message_stop` |
| Tools | Forced `tool_choice` → `content_block_start` with `type: tool_use`, `call_…` id bridged, empty `input` |
| SSE ping / quiet windows | `: keepalive` comment frame observed live mid-stream; re-framer translates upstream pings → canonical keepalive (`packages/buckle/src/sse.ts:36`, `handlers.ts:1104`) |
| True upstream silence | Bounded: gate errors the stream after `stream_idle_timeout_s ?? 60` (router.ts:689) with a typed in-band error — never an indefinite hang |
| `cache_control` preserved | Client-placed markers never rewritten (W768 law); live probe: request 1 `in=2023, read=0`, request 2 `in=39, read=1984` — `cache_read_input_tokens > 0` after the first request |
| `GET /v1/models` auto-discovery | 200 with the desktop key via the lane prefix, 57 model ids |

## Credential (minted, never printed)

Key `claude-desktop-muramasa` (`aa7ee9285c96`), scope `buckle:proxy:WRITE_`,
minted from the admin API and stored in
`~/.claude/local-llm/claude-desktop.env` (mode 0600) together with the
configured base URL:

- `BUCKLE_DESKTOP_KEY` — the `bksk_` material (paste into Desktop once)
- `BUCKLE_DESKTOP_BASE_URL` — `http://127.0.0.1:4101/w/claude-desktop`
  (app and spoke co-located; LAN form: `http://<mac-spoke>:4101/w/claude-desktop`)

Rotation = rerun the lane probe (revokes the stale key, mints fresh, rewrites
the conf). Test/retired keys get revoked, never left behind.

## Desktop configuration (one-time GUI step)

Settings → Developer → Configure Third-Party Inference:

- **provider**: `gateway`
- **baseUrl**: from `BUCKLE_DESKTOP_BASE_URL` in the 0600 conf
  (`http://127.0.0.1:4101/w/claude-desktop` on the spoke host; the `/w/`
  prefix tags every ride `lane=claude-desktop` in the audit row on top of
  the key attribution)
- **apiKey**: `BUCKLE_DESKTOP_KEY` from the 0600 conf
- **inferenceModels**: not needed — `GET /v1/models` auto-discovery verified;
  pin only to narrow the picker
- **inferenceStreamIdleTimeoutSec**: default is compatible (gate keepalives
  feed the socket during quiet windows; true silence is error-bounded at ≤60s)
- **inferenceCustomHeaders**: not needed — tenant routing already rides the
  credential (cache-boundary law) plus the `/w/claude-desktop` lane slug

## Acceptance evidence

Admin read model filtered by the desktop consumer key
(`GET /v1/admin/requests?key=aa7ee9285c96&inference=true`): rows with
`lane=claude-desktop`, `dialect=anthropic`, `decision=policy`, `status=200
ok=1`, cache tokens carried per row. The remaining owner step is the GUI
paste above — the app-managed store (config.json) holds no third-party
inference keys until first GUI save, so the paste is the one step this lane
cannot do for the owner. Every wire property behind that paste is
live-verified here.

## Probe harness

The lane probe (`.klh-scratch/w1230-verify.ts` in the W1230 worktree,
untracked) is the rotation+verification harness: custody reuse-or-rotate,
models discovery, non-stream + stream+tools ladders, the cache probe, and
the route_audit readback. It reads `BUCKLE_ADMIN_KEY` from belt.env and the
desktop key from the 0600 conf; neither is ever printed.
