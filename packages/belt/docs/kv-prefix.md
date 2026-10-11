# Packet-prefix KV — persistent, shippable prompt KV for the swarm

W240. The swarm's chat specialists keep their prompt cache in RAM only: the
mlx_lm server LRU dies with the process and rapid-mlx's prefix cache likewise
dies with the process, so every W500 idle-reap of a specialist throws away the
~9k-token harness prefix it had prefillied. This module makes that prefix a
FILE — persistent across restarts/reaps, and shippable between fleet Macs
(CacheGen-class shipping: int8-quantized KV + gzip + HTTP, no model reload on
the far side).

## What exists on this machine

- `bun bin/kv-prefix.ts build` — render the captured packet prefix exactly
  server-style (apply_chat_template with tools), prefill quantized KV
  (`--kv-bits 8 --kv-group-size 64`) via mlx_lm's cache_prompt CLI
  (generate_step with max_tokens=0), and save in mlx_lm's own
  save_prompt_cache format. Artifacts land in
  `~/.claude/local-llm/kv/<model-slug>/<idsSha>.safetensors` + a `.boot.` copy
  for the server flag and a JSON meta sidecar (version:1,
  kind:"belt-kv-prefix", model, idsSha — sha256 of the token ids, prefixSha
  — sha256-16 of the prefix doc, tokenCount, kv settings, mlxLmVersion,
  cacheBytes, prefix doc).
- `bun bin/kv-prefix.ts warm :8902` / `warm-all` — today's consumption path:
  replay the prefix through the OpenAI endpoint (system-only, nonce user
  turn, max_tokens=1). The server's token-trie LRU hands later requests
  sharing the system prefix their KV without recompute. Proven live:
  identical replays 351ms → 161ms → 122ms.
  - rapid-mlx rejects harness tool names (OpenAI name regex), so warm is
    system-only by default (`--tools` opts in).
- `bun bin/kv-prefix.ts probe` — spawn the installed mlx_lm server --help
  and record which KV flags it declares to
  `~/.claude/local-llm/kv/server-flags.json`. On 0.31.3 both are false: the
  server has NO cache-file ingestion. `spawnArgs` (spawner.ts) appends
  `--prompt-cache-file`/`--kv-bits` ONLY when this probe says the installed
  server declares the flags AND a cache exists — no-op today, lights up with
  no code change when upstream ships ingestion.
- `bun bin/kv-ship.ts pack` — gzip the latest cache into a KVPACK container
  (magic "KVPK1\0" + u32le metaLen + meta JSON + cache bytes, gzipped; caps:
  meta ≤1MiB, cache ≤8GiB) in `~/.claude/local-llm/kv/outbox/`.
- `bun bin/kv-ship.ts serve` — the LAN face: :8919 default, loopback by
  default; a non-loopback bind refuses to start without
  `BELT_KV_SHIP_TOKEN`. Plus `pull`/`push` to/from a peer and
  `report`/`verify`.
- `unpack` validates magic, meta cap, schema, sha format, and the byte cap
  BEFORE a single cache byte is written; install = cache + boot copy + meta 0600.

## The honest 0.31.3 note

The mission named `--prompt-cache-file` + `--kv-bits` — those flags live on
mlx_lm's cache_prompt CLI (verified in the installed 0.31.3 source), NOT on
mlx_lm.server. The server cannot ingest cache files at all — only a RAM LRU
(`--prompt-cache-size`, LRU count) with token-trie longest-common-prefix
matching. So the deliverable is: the KV FILE is the persistent/shippable
artifact; consumption TODAY is warm replay through the OpenAI endpoint; the
server-side flag wiring is capability-probed and inert until upstream ships
ingestion.

## Live evidence (this machine, 2026-10-11)

- build: 7915 tokens, kv8/g64, prefill 3.3s → 591.3MiB cache
- verify: pass (size == meta.cacheBytes)
- warm :8902: 351ms → 161ms → 122ms identical replays (trie residency)
- pack 537.0MiB in 7.5s; loopback serve→pull→install 2.76s, installed
  bytes identical to source (620,050,103 both sides)
- pack/unpack flush law (live finding): one `pipeline()` must own every
  stream through close — `pipe()` + a second `end()` let the process exit
  before the final flush; a 537MiB pack landed without its gzip trailer.
  Same law on the unpack side: single awaited end, destroy on error.
- 22 unit tests green (`w240-kv-prefix.test.ts`,
  `w240-kv-ship.test.ts`); belt full suite's 3 fails are pre-existing
  (proven via detached worktree baseline @7a41195).
