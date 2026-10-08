# fleet benchmarks — the ONE table (owner law: decision-grade rows only)

What model/runner to use, per task. Speed = wall-clock medians, nonce-cold,
single-stream. Quality claims carry their n; rows must choose between
alternatives. Raw records live in `packages/belt/` reports and
`packages/belt/bench/arena/results/` (gitignored) — this file holds verdicts,
not dumps.

## 0. Decision table — what to use, per task class

The one glance. Every row traces to a section below.

| Task class                  | Use                                                            | Runner-up                           | Never                                       | Evidence                                     |
| --------------------------- | -------------------------------------------------------------- | ----------------------------------- | ------------------------------------------- | -------------------------------------------- |
| a short-chat                | **local-direct** (6× faster, better, free)                     | engine-local                        | pure z.ai (thinking eats the budget)        | W274 n=33                                    |
| b code-gen                  | **cloud** (pure or engine-zai)                                 | —                                   | router placement (loses quality)            | W274 n=33                                    |
| c extract                   | **local-direct** (6× faster, free)                             | engine-local                        | router placement                            | W274 n=33                                    |
| d reasoning                 | **cloud** (engine-zai parity; local parity speed, −$0.19 weak) | local-direct                        | router placement (loses quality)            | W274 n=33                                    |
| e decision                  | **engine-zai** (free hop, parity)                              | local-direct (20× faster, unproven) | —                                           | W274 n=33                                    |
| f long-ctx                  | **local-direct** (2× faster, −$2.07/1k weak)                   | engine-local                        | router `:4000` (3.5× slower)                | W274 n=33                                    |
| danish/general              | :8906 on-demand                                                | —                                   | —                                           | fleet lineup                                 |
| passage rerank              | :8913 (rank by p_yes, never threshold)                         | —                                   | card-level routing gate                     | §4                                           |
| fit classification          | :8902 chat-JSON                                                | —                                   | kev-4B (4/12 agreement)                     | §4                                           |
| decision models             | kev-4B :8912                                                   | —                                   | Laya 421M/322M (40% misroute)               | §4                                           |
| install                     | bash install.sh (cutover stands, 1.18×)                        | —                                   | —                                           | §4                                           |
| local 35B vs cloud frontier | **UNSETTLED — 2026-10-08 redo in flight**                      | —                                   | claiming winners from the invalid 10-07 run | W532/W536, lesson.bench-zai-thinking-ceiling |

## 1. Fleet lineup — M5 Max 128GB (fleet medians, 2026-09-23; W535 slots re-proven 2026-10-07)

| Port | Role           | Model                       | GB  | tok/s (median) | Verdict                                               |
| ---- | -------------- | --------------------------- | --- | -------------- | ----------------------------------------------------- |
| 8901 | code           | Qwen3-Coder-30B-A3B-4bit    | 18  | 123.7          | MoE (3B active) — survived two dense challengers (§4) |
| 8902 | extract/menial | Qwen3-4B-Instruct-2507-4bit | 2.5 | 158.9          | fastest port in fleet (dense on purpose at this size) |
| 8903 | reason/best    | Qwen3.5-35B-A3B-OptiQ-4bit  | 22  | 123.6          | MoE — best quality×speed; OptiQ +25% same-day (W228)  |
| 8906 | danish/general | Qwen3.5-9B-MLX-4bit           | 5   | 85.2           | on-demand                                             |
| 8913 | rerank         | Qwen3-Reranker-0.6B         | 0.5 | —              | rank-only (22ms p50): acc@0.5 4/10 — see §4           |

## 2. Stack vs cloud — the verdict (W274, n=33, sealed harness, all setups AS-IS)

Methodology + raw numbers: [bench-plan.md](packages/belt/bench-plan.md),
[REPORT-n33.md](packages/belt/REPORT-n33.md). Rows are **pre-W270** (post-fix
rerun = the 2026-10-08 redo, §6). "non-inf" = paired 95% CI lower bound ≥
−10 pts. `elec` = local tier, no marginal API cost.

| Setup          | Speed vs pure | Quality (weak)        | Verdict                                                  |
| -------------- | ------------: | --------------------- | -------------------------------------------------------- |
| pure z.ai API  |            1× | reference             | quality default for code + reasoning                     |
| router `:4000` |    0.17–3.49× | non-inf on a, e only  | wins short-chat only; loses quality on code/reasoning    |
| engine-zai     |    0.79–1.08× | non-inf on c, d, e, f | gateway hop on cloud legs is free — keep                 |
| engine-local   |    0.28–1.27× | non-inf on a, c, f    | hop costs 1.2–5.5× vs local-direct — bypass hot tiers    |
| local-direct   |    0.05–1.04× | non-inf on a, c, d, f | **best stack setup**: wins short-chat, extract, long-ctx |
| kev `:8912`    |     0.41× (e) | 91%, not non-inf      | decision fallback only                                   |

Class winners (the rows that decided §0):

| Class        | Winner                                | Loser worth remembering                         |
| ------------ | ------------------------------------- | ----------------------------------------------- |
| a short-chat | local-direct 3.2s @ 94% (6× faster)   | pure 18.1s @ 33% — thinking ate the cap         |
| b code-gen   | pure 9.8s @ 97%                       | router 3.0s @ 70% — fast but loses quality      |
| c extract    | local-direct 0.63s @ 100% (6× faster) | router 5.2s @ 73%                               |
| d reasoning  | pure 7.1s @ 94%                       | router 3.8s @ 79% — faster but worse            |
| e decision   | engine-zai 3.2s @ 100%                | local-direct 148ms @ 85% — 20× faster, unproven |
| f long-ctx   | local-direct 1.5s @ 97% (2× faster)   | router 9.7s @ 94% — **stack loses on :4000**    |

Why direct tiers: the `:4000` router adds 1.4–25× wall over oracle placement
on e/c/b/f and loses quality on b/c/d; it only pays on short-chat. The
LiteLLM hop is free on cloud but costs 1.2–5.5× on local tiers — the W270
direct-tier bypass motivation. Warm-prefix cache effects and the full
per-class matrix (n=33): REPORT-n33.md.

## 3. Prompt transforms — condense/enhance (W367.3)

144 cold requests per variant, 6 classes. **Verdict:** keep the deterministic
caveman tier as the inbound default (quality-neutral, zero latency);
**never enable enhance on the local swarm** — it collapses quality (code
71→8%, extract 100→38%, chat 96→0%) while inflating prompts 2–5×. Buckle
politeness sideband stays OFF. Full per-cell matrices:
`packages/belt/bench/arena/variants-report.md` (W368 re-benches all three
blam tiers per model).

## 4. Component verdicts

| Comparison                                                 | Result                                      | Verdict                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| MoE 35B-A3B vs dense Qwen3.8-27B                           | 147.9 vs 28.3 tok/s (5.2×)                  | MoE wins at equal quality                                                                      |
| bf16 KV vs int8 KV (Coder-30B)                             | 107.4 vs 87.3 tok/s                         | bf16 KV wins                                                                                   |
| rapid-mlx vs mlx_lm.server (Coder-30B)                     | 121.8 vs 91.9 tok/s (+33%)                  | rapid-mlx runner wins                                                                          |
| Qwen3.5-35B-A3B-OptiQ vs -4bit (same model, W228)          | 107.2 vs 86.0 tok/s (+25%)                  | OptiQ takes the :8903 slot                                                                     |
| Qwopus3.6-27B-Coder-oQ4-mtp vs Coder-30B-A3B (:8901, W535) | 27.0 vs 89.3 tok/s                          | dense coder loses — slot unchanged                                                             |
| Fara1.5-27B-OptiQ-4bit vs 35B-A3B-OptiQ (:8903, W535)      | 22.7 vs 118.0 tok/s                         | dense reasoner loses — slot unchanged                                                          |
| installer bash vs TS (W490.2)                              | 240 vs 282 ms (1.18×)                       | cutover stands (bar: 1.5×)                                                                     |
| dispatch: lane vs in-session subagent (W498, n=5 pairs)    | 73.2s vs 166.3s p50                         | **lane 2.3× faster** — dispatch small isolated fixes; subagents only for session-context tasks |
| fit classifier: :8902 chat-JSON vs kev-4B (W225)           | 357ms vs 1290ms, baseline vs 4/12 agreement | :8902 KEEP; kev REJECT for fit                                                                 |
| decision models: kev-4B vs Laya 421M/322M                  | 5/5 vs 3/5 (40% misroute)                   | kev-4B :8912 in production; Laya rejected                                                      |
| reranker :8913 — passage vs card routing (n=10×3)          | rank 3/3 correct; acc@0.5 4/10              | passage reranker KEEP; card-level gate REJECT (rank by p_yes, never threshold)                 |

## 5. Rejection log (what we tried and did NOT take)

| Date       | Model / thing                          | Verdict                                                                                                                          |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | Qwen3.8-27B (dense)                    | 28.3 vs 138.5 tok/s at equal probe quality — the :8903 slot stays Qwen3.5-35B-A3B                                                |
| 2026-09-27 | GLM-5.x locally                        | 204–418GB at 4-bit; no fit in 128GB — remote-only                                                                                |
| 2026-09-27 | Xing4.0-29B-A4B                        | MLA+MTP unproven in MLX, no expected edge (MLX port exists W535 but no mlx_lm arch — unservable)                                 |
| 2026-09-27 | Fastino-Nemotron-3.5-Lightning-Finance | English-only; no Danish context — general local model + own docs wins                                                            |
| 2026-09-27 | Intern-Decision-4B                     | 12/15 vs 13/15 fork replay, CUDA-only serving; revisit only if an MLX port appears                                               |
| 2026-10-02 | kev-4B as fit backend (belt + buckle)  | 4/12 agreement, 3.6× latency, 1.6× tokens vs :8902 chat-JSON (W225)                                                              |
| 2026-10-02 | Jev as first-hit classifier            | 62.6% single-question phishing; only decomposition + fitted weights reached 95%                                                  |
| 2026-10-03 | Qwen3.5-9B-OptiQ-4bit                  | 68.5 vs 87.0 tok/s — :8906 stays 9B-MLX-4bit, weights deleted                                                                    |
| 2026-10-07 | Qwopus3.6-27B-Coder-oQ4-mtp            | 27.0 vs 89.3 tok/s (W535) — :8901 stays Coder-30B-A3B, weights deleted                                                           |
| 2026-10-07 | Fara1.5-27B-OptiQ-4bit                 | 22.7 vs 118.0 tok/s (W535) — :8903 stays 35B-A3B-OptiQ, weights deleted                                                          |
| 2026-10-07 | 2026-10-07 overnight local-vs-z.ai run | INVALID — z.ai leg truncated mid-thinking (4096 cap), identities unverified, frontier missing. lesson.bench-zai-thinking-ceiling |

## 6. Open benchmarks — tracked in the work graph, not here

- **2026-10-08 redo** (successor of W532/W536): local 35B-A3B vs z.ai (flash +
  frontier) vs claude (sonnet-5 seat) vs copilot claude-opus-5.5 — per-round
  served identity, reasoning vs answer tokens split, uncapped budgets,
  frontier included. Harness: `packages/belt/bench/arena/` (legs.ts).
- **W536 remainder** — W274 post-W270 router/engine rerun + buckle gateway
  acceptance probes (still OPEN).
