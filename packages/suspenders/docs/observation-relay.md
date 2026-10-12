# Observation relay — operator configuration

The bounded lane-observation relay (W477/478): each board forwards lane
observations to peer boards it is configured with. Origin and immediate peer
are separate axes — `originHub` is preserved end to end, `peerHub` always
records the immediate hop. Observations grant no work authority; unobserved
lanes remain unknown.

Values live in machine-level config, never in any repo (config-over-code).
This page carries placeholders only.

## Configuration (per participating board)

`~/.config/klh/observation-relays.json`, mode must be exactly `0600`:

```json
{
  "localHub": "<this-hub-id>",
  "targets": [
    {
      "url": "https://<target-host>",
      "hubId": "<target-hub-id>",
      "writeTokenFile": "/absolute/path/to/target-token-file"
    }
  ]
}
```

Token file per target: single line, mode `0600`, contents = the TARGET board's
per-install write token (the board generates it on first start at
`~/.cache/claude-governor/write-token`, `SUSPENDERS_WRITE_TOKEN_FILE`
overrides). Tokens are provisioned out-of-band by the operator — read the
token ON the target board, never across the network.

## Validator rules (`readRelayConfig`)

- Config file: mode `0600` exactly, plain JSON object, ≤ 32 KiB. Missing file
  = clean `disabled`; malformed = `lastError`, relay stays off.
- `localHub` / `hubId`: identity — non-empty, ≤ 128 chars, no control
  characters, never `all` or `unknown`.
- ≤ 8 targets, unique origin per target, `writeTokenFile` must be absolute.
- Target URLs: origin-only (no path, query, userinfo, hash); `http` is
  accepted only for `localhost`/`127.0.0.1`/`[::1]` — remote targets require
  HTTPS, and the URL host must be in the target board's
  `SUSPENDERS_ALLOWED_HOSTS` (W264 host guard), e.g. a `.local` name.

## Runtime behavior

- Starts with `fleet-board` (`startObservationRelay`); 10 s tick, ≤ 100
  jobs/tick, 4-way concurrency, 3 s timeout, per-target backoff ≤ 30 s,
  8000-key sent ring, config re-read every tick (edit-and-go-live, no
  restart).
- Each POST is one lane observation to `POST /api/lane-observations` with the
  target's token as `X-KLH-Write-Token`.
- Status: `/api/data` `observationRelay` + the board GUI note ("Relay
  disabled: configure machine-level observation-relays.json." until
  configured). Recorded remote lanes: `GET /api/lane-observations`.

## Three-hop verification (A → B → C)

1. Configure A targeting B (B's token), B targeting C (C's token). Targets
   without `hubId` can receive, but cannot relay onward (loop protection).
2. After two ticks: `GET /api/lane-observations` on B lists A-origin lanes
   (`originHub: "A"`, `peerHub: "B"`, `visitedHubs: ["A", "B"]`).
3. On C: `originHub: "A"` preserved, `peerHub: "C"`,
   `visitedHubs: ["A", "B", "C"]`.
4. Board GUI note reads `Relay <localHub>: N sent · M pending`.

Sequencing: remote boards must run current code (W486) — a stale board 404s
the ingest and the relay reports `Relay rejected: HTTP 404`.
