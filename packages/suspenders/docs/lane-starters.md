# Lane starter sessions + forked lane starts (W454)

One versioned **starter session** per harness holds the stable shared
orientation prefix (repo law + fleet protocol). Lanes **fork** it instead of
orienting from cold context; the lane-specific identity (sid, worktree, brief
path) is appended AFTER the fork so the shared prefix stays cache-stable.

- Flag: `SUSPENDERS_LANE_STARTER` — default ON for the claude executor since
  W768 (seed once, fork every lane; the W454 bench measured the win). Operators
  opt OUT with `=off` or `=0`. Per harness, enablement is adapter data
  (`starterDefault`) gated by the flag: `=on` forces every fork-capable
  harness (bench use), otherwise only measured adoptions default on. W808:
  codex verified + measured NOT adopted; copilot/gemini/grok verified with
  NO headless fork (2026-10-18 doc pass) and stay catalog-only.
- Wiring: `scripts/lib/lane-starter.ts` (`dispatchStarterFork`), called from
  `scripts/dispatch-next.ts` before spawn.
- The seed ride a fleet identity (`fleet-starter` attribution slug), never a
  lane's minted `bksk_` key; `assertNoSecrets` blocks credential material in
  the shared prefix; the registry (`<repo>/.fleet/starters/<harness>-<sha12>.json`,
  mode 0600) is capped at 8 records (bounded history, bounded registry).

## Harness catalog

Evidence tiers: **binary** = verified in the installed executor binary on
this host (2026-10-07); **doc-pending** = needs the harness's own docs before
any wiring; **unavailable** = no local binary.

| Harness | Fork/resume surface | Token/usage surface | Fork wiring | Tier |
| --- | --- | --- | --- | --- |
| claude | `--resume <id> --fork-session` (also `--resume-session-at`, `--resume-drops-turn`, `--resume-from`, `--session-id`) | `-p --output-format json` → `usage.{input,output_tokens}`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `duration_ms` | **wired** (seed → fork per lane) | binary |
| codex | `exec fork <id>` — binary-verified live on 0.158 (2026-10-18): each fork answers a NEW thread id, parent thread untouched; seed via `exec --json -s read-only <seed>` | JSONL `thread.started`/`turn.completed`: `usage.input_tokens` INCLUDES `cached_input_tokens` (OpenAI semantics), `cache_write_input_tokens` exists | **wired** (adapter `seedArgs`/`forkArgs` + head/prompt spawn slots) — measured NOT adopted, opt-in `SUSPENDERS_LANE_STARTER=on` | binary (0.158 live) |
| copilot | docs 2026-10-18: `-p --resume=SESSION-ID` is the headless resume (bare `--resume` needs a TTY picker); `/fork`/`/branch` are interactive SLASH commands only — no CLI fork flag, resume is in-place | usage fields unknown; no local binary on this host | catalog-only (fork gate unmet: resume would append every lane to the SAME starter session) | doc (resume), doc-pending (usage) |
| gemini | docs 2026-10-18: `--resume <uuid>` in-place + `/chat save\|resume <tag>` interactive; no fork semantics; not in the executor ladder (`resolveLaneExecutor`: claude/copilot/codex) | — | not supported | unavailable (no host binary) |
| grok | community grok-cli docs 2026-10-18: `--session latest`/`-s` in-place continue + `--prompt`/`--format json` headless; no fork; hook adapter exists (hook-adapter-grok) | — | catalog-only (fork gate unmet) | doc (continue), no host binary |

## Measured results (2026-10-07, this host, n=3, belt-front routing)

| Phase | mode | wall mean | fresh input mean | cache_read mean | cache share |
| --- | --- | --- | --- | --- | --- |
| PRE | cold | 29.8 s | 10 432 tok | 93 035 tok | 90% |
| POST | fork | 16.7 s | 1 100 tok | 49 195 tok | 98% |

Forks got NEW session ids per run (`--fork-session`) — the starter session
stays 1-turn intact. Caveats: n=3 with high wall variance (gateway), warm
provider cache, probe child rode the measuring lane's attribution. Seed
success criterion is session-id presence, NOT exit code (the CLI exits 1 on
trailing `unrecognized_model` diagnostics while the session is valid —
observed live).

## W768 adoption run (2026-10-15, this host, n=3, live lane route)

POST re-measured at activation: starter `f4dae8ae032c` seeded once (session
`5117dbe1…`), three forks took three NEW session ids. Fork mode mean wall
15.8 s (13.5/16.3/17.5), fresh input mean 1 659 tok (4 447/371/159), cache
share 97% — matches the 2026-10-07 shape. Same-day cold re-measure was
heavily skewed by one multi-turn wander (504 s wall, 17 k output tok);
cold medians vs fork medians: wall 76.6 s → 16.3 s (−79%), fresh input
49 752 → 371 tok (−99%). This is the measured win the default-ON flip is
wired on; `SUSPENDERS_LANE_STARTER=off` opts out.

The same fork grammar IS the warm-resume mechanism (W622 resume-from):
within the 10-min transcript-TTL fence, a warm resume costs fork-class
tokens; past it, fresh-lane doctrine stands. The W768 default covers the
general orientation case; transcript resume stays policy-gated.

## W808 codex fork leg (2026-10-18, this host, n=3, codex 0.158)

Fork grammar verified live before wiring (`exec fork <id>` → new thread id
per fork, parent intact). Bench: `bun scripts/orientation-bench.ts --harness
codex --runs 3 --phase pre|post --starter on` (starter forced — codex is
not default-adopted).

| Phase | mode | wall mean | input mean (incl cached) | fresh input mean | cache share |
| --- | --- | --- | --- | --- | --- |
| PRE | cold | 8.3 s | 63 239 tok | 20 017 tok | 41% |
| POST | fork | 7.7 s | 106 244 tok | 28 379 tok | 40% |

VERDICT: NOT ADOPTED. The fork replays the FULL seed history each turn and
OpenAI usage counts input inclusive of cached tokens, so fresh input rose
+42% (20.0k → 28.4k) while the wall delta (−7%) sits inside run variance
and cache share stayed flat. Codex keeps the cold-start default; the fork
path stays reachable via `SUSPENDERS_LANE_STARTER=on`. The codex dispatch
spawn is functional regardless (adapter head/prompt slots — positional
prompt LAST, `-p` is `--profile` on this CLI).

## Benchmark protocol (Phase 1 PRE / Phase 3 POST)

`bun scripts/orientation-bench.ts --harness claude --runs 3 --phase pre|post`
spawns the real harness per run with a deterministic first productive action
(`git rev-parse HEAD`) and records NDJSON rows (wall ms, input/output/cache
split, session id) to `.fleet/orientation-bench/<phase>-<harness>.ndjson`.
PRE = cold starts; POST = forked starts (for a harness without default
adoption, pass `--starter on` to force fork mode). ADOPT per harness only
on measured wins (wall, input tokens, cache-read share).

Missing executor bin → exit 3 `UNAVAILABLE` (honest); all-runs-failed →
exit 4. Usage fields a harness does not expose stay `null` — never guessed.

## Extra capability knobs found (binary evidence)

- claude `--resume-session-at` / `--resume-from` / `--resume-drops-turn`:
  partial-history resume — candidate knob for bounded-history resumes (not
  wired; catalog row).
- codex `previous_response_id` chaining: the Responses-API route for forked
  lane starts without CLI support — moot for the CLI now that `exec fork`
  verifies, relevant if codex ever rides a raw API lane.
