# Lane starter sessions + forked lane starts (W454)

One versioned **starter session** per harness holds the stable shared
orientation prefix (repo law + fleet protocol). Lanes **fork** it instead of
orienting from cold context; the lane-specific identity (sid, worktree, brief
path) is appended AFTER the fork so the shared prefix stays cache-stable.

- Flag: `SUSPENDERS_LANE_STARTER=on` (default off — adopt per harness only on
  measured wins, see the benchmark below).
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
| codex | `resume` verb, `forked_from_id`/`parent_thread_id` thread fields, `previous_response_id`, `resume_thread_from_history` | `cached_input_tokens` / `cache_write_input_tokens` / `total_tokens` usage records exist | catalog-only — the dispatch spawn recipe hardcodes `-p`, codex takes a positional prompt; needs a wrapper (or recipe change) first | binary (flags), doc-pending (exec-resume arg order) |
| copilot | session resume/fork semantics UNVERIFIED — no local binary; BYOK proven separately (finding.copilot-byok) | usage fields unknown | catalog-only | doc-pending |
| gemini | not in the executor ladder (`resolveLaneExecutor`: claude/copilot/codex) | — | not supported | unavailable |
| grok | hook adapter exists (hook-adapter-grok); session fork surface unverified | — | catalog-only | doc-pending |

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

## Benchmark protocol (Phase 1 PRE / Phase 3 POST)

`bun scripts/orientation-bench.ts --harness claude --runs 3 --phase pre|post`
spawns the real harness per run with a deterministic first productive action
(`git rev-parse HEAD`) and records NDJSON rows (wall ms, input/output/cache
split, session id) to `.fleet/orientation-bench/<phase>-<harness>.ndjson`.
PRE = cold starts; POST = `SUSPENDERS_LANE_STARTER=on` forked starts. ADOPT
per harness only on measured wins (wall, input tokens, cache-read share).

Missing executor bin → exit 3 `UNAVAILABLE` (honest); all-runs-failed →
exit 4. Usage fields a harness does not expose stay `null` — never guessed.

## Extra capability knobs found (binary evidence)

- claude `--resume-session-at` / `--resume-from` / `--resume-drops-turn`:
  partial-history resume — candidate knob for bounded-history resumes (not
  wired; catalog row).
- codex `previous_response_id` chaining + fork thread fields: the Responses
  API route for forked lane starts without CLI support.
