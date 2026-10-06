# fleet benchmarks — the ONE table (owner law, 2026-10-05)

ALL benchmarks live in this single file at the fleet root. Package-level
benchmarks.md files are pointers; do not start new ones. One curated row
per model/probe/setup, few params, medians decide — not an LLM dump.

**Do not store bench data in other .md files** — update this table instead.

Laws (fleet-wide): run on **AC power only** (never battery); medians over
N≥12 unless noted; speed rows are solid, quality rows need ≥130 paired
questions (33 → ±15 pts, 130 → ±7, 530 → ±4) — anything smaller is a smoke
test; score per class, never blended; one lever at a time; re-run after any
model bump.

---

## belt — model fleet (curated)

THE canonical benchmark table for belt (owner law, 2026-10-02). The
questions we ask of each model class live in
[bench-questions.md](packages/belt/bench-questions.md); raw append-only
records in [bench/benchmarks.jsonl](packages/belt/bench/benchmarks.jsonl).

Runner: `bun bin/bench-suite.ts --port <port> --model <id> --label <short>`
(from packages/belt). TTFT/prefill:
`bun bin/bench-suite.ts --ttft --port <port> --sizes 2000,8000,32000`
(cold + prefix-cache-hit TTFT medians; meta: engine, revision, flags, power,
thermal; refuses without `/tmp/bench-ac-ok`).
Fit bench: `bun bin/bench-fit.ts`.

## Stack vs pure API — bench-arena findings (W274, all setups AS-IS)

Question: does the klh stack beat pure z.ai API access? Sealed harness
(manifest `6253f5092545542e`, methodology + labels in
[bench-plan.md](packages/belt/bench-plan.md)), single-stream, nonce-cold,
AC power. Runs: `2026-10-02T21-31-09` (n=12,
[REPORT-n12.md](packages/belt/REPORT-n12.md)) and `2026-10-02T22-09-09`
(n=33, [REPORT-n33.md](packages/belt/REPORT-n33.md)). The post-W270-fix
run (REPORT-postw270.md) had not landed when this table was compiled — see
the gap note below.

**Honesty labels** (bench-plan §5): speed medians n≥12 = **strong**;
quality n=33 = **weak** (±15 pts), n=12 = insufficient. "non-inf" = paired
95% CI of Δquality lower bound ≥ −10 pts at n=33; only then is a Δ$ claimed.
`elec` = local tier, no marginal API cost, electricity unmetered (not free).
Contention: five feature lanes ran throughout — load1 27–84 (n=33), 13–41
(n=12); it hits local/stack legs, not z.ai, i.e. biases _against_ the stack.

Setups: **pure** = z.ai API direct (GLM-5.3-Flash, baseline) · **router** =
stack via `:4000` (Anthropic wire, real placement) · **engine-zai** /
**engine-local** = stack via `:4100` LiteLLM (cloud model / oracle local
tier) · **local-direct** = raw `:890x` (oracle placement) · **kev** = `:8912`
(decision only).

### Per-class findings (n=33 primary; × = paired median wall ratio vs pure)

| Class        | Setup        | wall p50 ms | × pure | × @n=12 | pass% [Wilson 95%] (weak) | $/1k tasks | Verdict                                          |
| ------------ | ------------ | ----------: | -----: | ------: | ------------------------- | ---------: | ------------------------------------------------ |
| e decision   | pure         |       3,575 |      1 |       1 | 100 [90, 100]             |     $0.099 | reference                                        |
| e decision   | router       |       4,519 |  1.01× |   1.11× | 97 [85, 99] non-inf       |       elec | speed tie, −$0.099 claimable (weak)              |
| e decision   | engine-zai   |       3,244 |  0.81× |   0.89× | 100 [90, 100] non-inf     |     $0.089 | LiteLLM hop on cloud costs nothing               |
| e decision   | engine-local |       1,225 |  0.40× |   0.46× | 85 [69, 93] not shown     |       elec | fast, misses `cloud` labels (2/7)                |
| e decision   | local-direct |         148 |  0.05× |   0.05× | 85 [69, 93] not shown     |       elec | 20× faster, quality unproven                     |
| e decision   | kev          |       1,005 |  0.41× |   0.21× | 91 [76, 97] not shown     |       elec | best local accuracy, not non-inf                 |
| d reasoning  | pure         |       7,103 |      1 |       1 | 94 [80, 98]               |      $0.19 | reference                                        |
| d reasoning  | router       |       3,838 |  0.61× |   0.73× | 79 [62, 89] not shown     |       elec | faster but loses quality — keep reason on cloud  |
| d reasoning  | engine-zai   |       6,898 |  1.02× |   1.00× | 94 [80, 98] non-inf       |      $0.19 | parity                                           |
| d reasoning  | engine-local |      10,301 |  1.27× |   1.13× | 88 [73, 95] not shown     |       elec | slower + unproven                                |
| d reasoning  | local-direct |       8,910 |  1.04× |   0.97× | 91 [76, 97] non-inf       |       elec | parity speed, −$0.19 claimable (weak)            |
| a short-chat | pure         |      18,148 |      1 |       1 | 33 [20, 50] (70% trunc)   |      $0.50 | thinking eats the 1024 budget                    |
| a short-chat | router       |       3,005 |  0.17× |   0.15× | 94 [80, 98] non-inf       |       elec | **stack wins**: 6× faster, better, −$0.50 (weak) |
| a short-chat | engine-zai   |      17,832 |  1.01× |   1.03× | 24 [13, 41] not shown     |      $0.50 | same model, same truncation                      |
| a short-chat | engine-local |       6,021 |  0.34× |   0.25× | 100 [90, 100] non-inf     |       elec | wins, LiteLLM hop ~2× vs direct                  |
| a short-chat | local-direct |       3,204 |  0.17× |   0.16× | 94 [80, 98] non-inf       |       elec | **stack wins** (oracle placement)                |
| c extract    | pure         |       4,173 |      1 |       1 | 100 [90, 100]             |      $0.16 | reference                                        |
| c extract    | router       |       5,237 |  1.08× |   0.96× | 73 [56, 85] not shown     |       elec | router misplaces/degrades extract                |
| c extract    | engine-zai   |       4,749 |  1.08× |   1.15× | 100 [90, 100] non-inf     |      $0.15 | parity                                           |
| c extract    | engine-local |       1,101 |  0.28× |   0.77× | 100 [90, 100] non-inf     |       elec | wins, −$0.16 claimable (weak)                    |
| c extract    | local-direct |         629 |  0.16× |   0.19× | 100 [90, 100] non-inf     |       elec | **stack wins**: 6× faster, −$0.16 (weak)         |
| b code-gen   | pure         |       9,789 |      1 |       1 | 97 [85, 99]               |      $0.30 | reference                                        |
| b code-gen   | router       |       3,017 |  0.37× |   0.21× | 70 [53, 83] not shown     |       elec | fast, quality loss — code stays cloud            |
| b code-gen   | engine-zai   |       8,746 |  0.79× |   1.02× | 94 [80, 98] not shown     |      $0.31 | parity within noise                              |
| b code-gen   | engine-local |       2,582 |  0.29× |   0.33× | 79 [62, 89] not shown     |       elec | fast, quality unproven                           |
| b code-gen   | local-direct |       1,949 |  0.23× |   0.17× | 79 [62, 89] not shown     |       elec | fast, quality unproven                           |
| f long-ctx   | pure         |       2,687 |      1 |       1 | 100 [90, 100]             |      $2.07 | reference (most expensive class)                 |
| f long-ctx   | router       |       9,662 |  3.49× |   2.74× | 94 [80, 98] not shown     |       elec | **stack loses**: 3.5× slower via `:4000`         |
| f long-ctx   | engine-zai   |       3,073 |  1.07× |   0.82× | 100 [90, 100] non-inf     |      $2.07 | parity                                           |
| f long-ctx   | engine-local |       2,425 |  0.79× |   0.93× | 97 [85, 99] non-inf       |       elec | −$2.07 claimable (weak)                          |
| f long-ctx   | local-direct |       1,536 |  0.53× |   0.38× | 97 [85, 99] non-inf       |       elec | **stack wins**: 2× faster, −$2.07 (weak)         |

Router-only placement (`stack-router`, 1-token, class e): 3/33 correct
(9% [3, 24]) at 159 ms — `:4000`'s own tier choice does not match the
sealed decision labels (it cannot emit `none`: 8 rows unwinnable).

### Warm-prefix TTFT (class f, q2 on the same prefix; n=12, speed strong)

| Setup        | TTFT p50 cold → warm ms | wall p50 cold → warm ms | cache% | Verdict                       |
| ------------ | ----------------------: | ----------------------: | -----: | ----------------------------- |
| pure         |           2,811 → 2,462 |           3,223 → 2,488 |      0 | z.ai implicit cache ~ −12%    |
| router       |             8,811 → 725 |             8,811 → 725 |      0 | 12× on warm (response/prefix) |
| engine-zai   |           2,547 → 2,694 |           2,560 → 2,739 |      0 | no cache benefit via LiteLLM  |
| engine-local |             3,472 → 831 |             3,603 → 953 |     10 | prefix cache 4×               |
| local-direct |             1,334 → 941 |           1,481 → 1,061 |     10 | prefix cache 1.4× (fast cold) |

The n=33 run did not repeat `--warm`; warm numbers are n=12 only.

### Router-value decomposition (n=33; × = paired median wall ratio A/B)

| Class | router vs oracle (router − local-direct) | router vs same model via gateway (router − engine-zai) | LiteLLM hop, cloud (engine-zai − pure) | LiteLLM hop, local (engine-local − local-direct) |
| ----- | ---------------------------------------- | ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------ |
| e     | Δq +0.12 non-inf · 25.5×                 | Δq −0.03 non-inf · 1.05×                               | 0.81×                                  | 5.48× (n=12: 3.92×)                              |
| d     | Δq −0.12 not shown · 0.52×               | Δq −0.15 not shown · 0.60×                             | 1.02×                                  | 1.19× (1.10×)                                    |
| a     | Δq 0.00 non-inf · 0.87×                  | Δq +0.55 non-inf · 0.17×                               | 1.01×                                  | 1.92× (1.71×)                                    |
| c     | Δq −0.07 not shown · 4.25×               | Δq −0.07 not shown · 1.01×                             | 1.08×                                  | 1.69× (3.49×)                                    |
| b     | Δq −0.09 not shown · 1.37×               | Δq −0.22 not shown · 0.36×                             | 0.79×                                  | 1.47× (1.35×)                                    |
| f     | Δq −0.03 not shown · 5.66×               | Δq −0.06 not shown · 3.11×                             | 1.07×                                  | 1.47× (1.71×)                                    |

Reading (speed strong, quality weak): the router adds 1.4–25× wall over
oracle placement on e/c/b/f and loses quality on b/c/d; it only pays on
short-chat. The LiteLLM hop is free on cloud (0.8–1.08×) but costs
1.2–5.5× on local tiers under load — the W270 direct-tier bypass motivation.

### AS-IS live probes (W274, 2026-10-03 07:31Z, load1 6.7–7.5, 55 requests)

| Probe                                   | Result                                        | Verdict                                       |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| `:4000/registry.json` (W271)            | 404                                           | W271 surface not deployed to the live shim    |
| `local-extract` 1-token: direct `:8902` | p50 91 ms (87–103), n=10                      | bypass works with the real model id           |
| `local-extract` 1-token: via `:4100`    | p50 100 ms (95–111), n=10 → 1.10×             | hop ≈ 9 ms at low load (bench saw +0.5–2.2 s) |
| W270 `resolveTarget()` alias on `:8902` | 10/10 404 `model_not_found` (`local-extract`) | **bug**: bypass must rewrite alias → model id |
| Kev `:8912/v1/models`                   | 200, <1 ms, `kev-latest` (kev-4b)             | healthy                                       |
| Embeddings `:8907`                      | connection refused, no listener               | DOWN                                          |

Live `routing-policy.yaml` has no `direct:` section (W270 not deployed); the
bypass map was taken from W270 commit `2d003cc`. Log: bench/RESULTS.md.

### Verdict per setup

| Setup          | Speed vs pure (strong) | Quality (weak, n=33)                   | Cost                   | Verdict                                                     |
| -------------- | ---------------------- | -------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| pure z.ai API  | 1×                     | reference; a fails on truncation (33%) | $0.10–$2.07/1k         | quality default for b, d                                    |
| router `:4000` | 0.17–3.49×             | non-inf on a, e only                   | elec                   | use for short-chat; fix f (3.5× slower) and b/c/d placement |
| engine-zai     | 0.79–1.08×             | non-inf on c, d, e, f                  | ≈ pure                 | free gateway hop for cloud — keep                           |
| engine-local   | 0.28–1.27×             | non-inf on a, c, f                     | elec                   | hop costs 1.2–5.5× vs direct — bypass hot tiers             |
| local-direct   | 0.05–1.04×             | non-inf on a, c, d, f                  | elec (−$0.16–$2.07/1k) | **best stack setup**: wins a, c, f outright                 |
| kev `:8912`    | 0.41× (e)              | 91% (e), not non-inf                   | elec                   | decision fallback only                                      |

Gap: REPORT-postw270.md (post-W270-fix rerun) was not available at compile
time — the router/engine-local rows above are pre-W270.

## Chat tiers — M5 Max 128GB (fleet medians, 2026-09-23)

| Port | Role           | Model                       | GB  | tok/s (median) | Verdict                                                     |
| ---- | -------------- | --------------------------- | --- | -------------- | ----------------------------------------------------------- |
| 8901 | code           | Qwen3-Coder-30B-A3B-4bit    | 18  | 123.7          | current coder tier                                          |
| 8902 | extract/menial | Qwen3-4B-Instruct-2507-4bit | 2.5 | 158.9          | fastest port in fleet                                       |
| 8903 | reason/best    | Qwen3.5-35B-A3B-OptiQ-4bit  | 22  | 123.6          | best quality×speed — OptiQ +25% same-day (W228, 2026-10-03) |
| 8906 | danish/general | Qwen3.5-9B-MLX-4bit         | 5   | 85.2           | on-demand                                                   |
| 8913 | rerank         | Qwen3-Reranker-0.6B         | 0.5 | —              | rank-only (22ms p50): acc@0.5 4/10 — see reranker section   |

## Measured A/B results

| Comparison                                          | Result                     | Verdict                     |
| --------------------------------------------------- | -------------------------- | --------------------------- |
| MoE 35B-A3B vs dense Qwen3.8-27B                    | 147.9 vs 28.3 tok/s (5.2×) | MoE wins at equal quality   |
| bf16 KV vs int8 KV (Coder-30B)                      | 107.4 vs 87.3 tok/s        | bf16 KV wins                |
| rapid-mlx 0.14.3 vs mlx_lm.server (code, Coder-30B) | 121.8 vs 91.9 tok/s (+33%) | rapid-mlx runner wins       |
| rapid-mlx vs mlx_lm.server (reason, dense 27B)      | 29.5 vs 24.8 tok/s (+19%)  | rapid-mlx runner wins       |
| Qwen3.5-35B-A3B-OptiQ vs -4bit (same model, W228)   | 107.2 vs 86.0 tok/s (+25%) | OptiQ takes the :8903 slot  |
| Engine swap (Coder-30B, mlx_lm → rapid-mlx)         | 97.4 → 123.7 tok/s         | biggest single lever so far |

## Installer cutover — bash vs TS full-install wall-time (W490.2, 2026-10-06)

The owner's-law row for the install.sh → install.ts cutover: FULL-install
wall-time, warm prefix, `--no-llm` both sides, same scope (harness copy +
shims + caddy register + release notify; llm seed/models skipped), 3
interleaved runs on this Mac (load1 3.2–5.2 — smoke-level n=3 per the brief;
medians decide; rollback bar 1.5×). Bash leg ran a frozen HEAD `e0441ed`
copy inside the package dir so `REPO_DIR` resolution matched; TS leg =
`install.sh --no-llm` → wrapper → `install.ts --yes` → delegation to
`install.sh __legacy full`.

| Leg                                         | wall p50 | spread  | Verdict                                     |
| ------------------------------------------- | -------: | ------- | ------------------------------------------- |
| bash (pre-cutover install.sh, e0441ed)      |   240 ms | 233–245 | reference                                   |
| TS (wrapper → install.ts → `__legacy full`) |   282 ms | 282–306 | **1.18× bash — cutover stands** (bar: 1.5×) |

The TS path still runs the legacy body (syncHarness/ensureShims/seedLocalLlm
have no native steps yet); the measured delta is the wrapper front + plan
runner + one execa hop. Launchd render via install-services.ts: 12 services
in 0.26 ms.

## Fit-classifier backends (W225, 2026-10-02, 12 tasks — smoke test)

| Backend                    |     p50 |     p95 | tokens/12 | agreement | Verdict                             |
| -------------------------- | ------: | ------: | --------: | --------- | ----------------------------------- |
| Qwen3-4B chat JSON (:8902) |   357ms |   876ms |     3,025 | baseline  | KEEP — default fit backend          |
| kev-4B SystemOne (:8912)   | 1,290ms | 1,463ms |     4,744 | 4/12      | REJECT for local fit (cost+latency) |

## Decision-model backends (classifier shootout, 2026-09, 5-task probe — smoke)

| Model                      | Accuracy                                                  | Latency | RAM  | Verdict                                            |
| -------------------------- | --------------------------------------------------------- | ------- | ---- | -------------------------------------------------- |
| Kev-9B                     | 5/5, p 0.98–1.00                                          | ~800ms  | 18GB | OOM-killed by macOS in a RAM spike                 |
| Kev-4B                     | 5/5, p 0.98–1.00                                          | ~1s     | ~8GB | in production, launchd-managed                     |
| Laya-MLX 421M (ModernBERT) | 3/5 — personal collapses into "coding" at 0.94 confidence | 9–28ms  | <1GB | rejected: a 40% misroute rate beats any speed gain |
| Laya-multilingual 322M     | 3/5                                                       | 9–28ms  | <1GB | rejected                                           |

`needs_strong`-style questions come back mushy from Kev (0.17–0.44) — use
`use_case` only unless you calibrate that head yourself.

## Reranker (:8913) — card-routing smoke (2026-10-03, starter n=10 × 3 rounds)

Official Qwen3-Reranker scoring: ChatML template + empty-think prefill via
`/v1/completions`, P(yes) vs P(no) at 1 generated token, temp 0, AC power.
Smoke only — n=10 ≪ 130, no quality claim.

| Instruct wording      | acc@0.5 | p50 latency | Notes                                      |
| --------------------- | ------- | ----------- | ------------------------------------------ |
| card-judging          | 4/10    | 22ms        | all 6 negatives pass; positives never >0.5 |
| hf-default retrieval  | 4/10    | 23ms        | same failures                              |
| none                  | 3/10    | 22ms        | same failures                              |
| rich 2-sentence cards | 4/10    | 25ms        | card verbosity is not the lever            |

Findings: threshold calibration fails on model-card prose — p_yes scales
with task match (0.02 bare label → 0.17 rich card → 0.67 task-matched real
sentence) but never crosses 0.5 for cards, while **ranking within a query
is 3/3 correct** (0.165>0.000, 0.798>0.000, 0.257>0.013). Latency: p50
22ms warm (610ms cold-start first call). Verdict: keep :8913 as a passage
RERANKER (its training distribution); reject as a card-level routing gate —
belt routing stays with the fit classifier (:8902). If ever used for cards:
rank by p_yes, never threshold. Protocol lesson: bare card labels
("coder-30B card") degenerate to all-no — candidates must carry text.

## W228 fleet refresh — pending (bench when: AC power + downloads done)

| Candidate                   |   GB | Challenging              | Status (2026-10-03)                                                                         |
| --------------------------- | ---: | ------------------------ | ------------------------------------------------------------------------------------------- |
| Qwen3.5-9B-OptiQ-4bit       |  7.1 | 8906 incumbent (5GB)     | **REJECTED 2026-10-03: 68.5 vs 87.0 tok/s (+3GB) — weights deleted**                        |
| Qwen3.5-35B-A3B-OptiQ-4bit  | 22.2 | 8903 incumbent (20GB)    | **WON the slot 2026-10-03 (107.2 vs 86.0 nonce-cold, +25%) — swapped, old weights deleted** |
| Qwopus3.6-27B-Coder-oQ4-mtp | 17.0 | 8901 incumbent (18GB)    | downloading (0.3/17GB)                                                                      |
| Fara1.5-27B-OptiQ-4bit      |    — | new candidate            | downloading (0.4GB)                                                                         |
| Xing4.0-29B-A4B-OptiQ-4bit  |    — | 8903 + rejection revisit | downloading (0.5GB) — the MLX port the 2026-09-27 rejection asked for                       |

Protocol: one-by-one A/B vs the incumbent; winner keeps the slot and this
table, loser weights get DELETED from the HF cache; rerun the full suite on
any model bump (managed-router lesson: the fleet changes underneath you).

Mechanized (W295): `bun bin/fleet-refresh.ts status --gb <id>=<gb>,…` ·
`pull <id>` · `ab --candidate <id> --incumbent-port <p> --incumbent-model
<id>` — nonce-cold legs (response-cache-proof), same-day incumbent re-bench,
loser weights deleted automatically (self-A/B deletion guard, `--keep`
override), verdict + medians + loadavg logged to benchmarks.jsonl.

## Rejection log

| Date       | Model                                  | Verdict                                                                                        |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 2026-09-23 | Qwen3.8-27B (dense)                    | 28.3 vs 138.5 tok/s at equal probe quality — the :8903 slot stays Qwen3.5-35B-A3B              |
| 2026-09-27 | GLM-5.x locally                        | 204–418GB at 4-bit; no fit in 128GB — remote-only                                              |
| 2026-09-27 | Xing4.0-29B-A4B                        | MLA+MTP unproven in MLX, no expected edge over Qwen3.5-35B-A3B                                 |
| 2026-09-27 | Fastino-Nemotron-3.5-Lightning-Finance | English-only; no Danish context — general local model + own docs wins                          |
| 2026-09-27 | Intern-Decision-4B                     | 12/15 vs 13/15 fork replay, CUDA-only serving; revisit only if an MLX port appears             |
| 2026-10-02 | kev-4B as belt fit-classifier          | 4/12 agreement, 3.6× latency, 1.6× tokens vs :8902 chat-JSON (W225)                            |
| 2026-10-03 | Qwen3.5-9B-OptiQ-4bit                  | 68.5 vs 87.0 tok/s re-benched same-day (load1 ~9.7) — :8906 stays 9B-MLX-4bit, weights deleted |

## buckle gateway (curated)

Canonical buckle table (owner law, 2026-10-02). The questions we ask live
in [bench-questions.md](packages/buckle/bench-questions.md).

## Wire/adapter probes (verified 2026-10-02)

| Probe                                 | Path                                   | Result                                                                                                                                                            |
| ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| copilot BYOK openai-wire → local tier | `COPILOT_PROVIDER_*` → :8903 `/v1`     | PASS — answered `PROOF-BYOK-LOCAL`, zero AI credits, no GitHub auth                                                                                               |
| claude CLI → belt router              | `ANTHROPIC_BASE_URL=:4000` + model pin | PASS — daily lanes run this                                                                                                                                       |
| copilot BYOK anthropic-wire → :4000   | `COPILOT_PROVIDER_TYPE=anthropic`      | FAIL — silent 1s abort; diagnosis pending (W223)                                                                                                                  |
| codex → :4100 responses wire          | CODEX_HOME `model_providers`           | PASS — temp CODEX_HOME + `wire_api="responses"` + `env_key=LITELLM_KEY`: `ENGINE-REACHABLE` (2026-10-03; ~12.5k harness tokens on a 1-line task = codex overhead) |

## Engine (W219.1 litellm-as-engine) — pending acceptance

| Dialect                          | Acceptance probe                     | Status |
| -------------------------------- | ------------------------------------ | ------ |
| github_copilot/gpt-5.2 via :4100 | e2e chat answer through buckle front | OPEN   |
| azure/bedrock/vertex via :4100   | e2e chat answer through buckle front | OPEN   |

## Rejection log — buckle

| Date       | Thing                        | Verdict                                                                                                                                    |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-02 | kev-4B as buckle fit backend | 4/12 agreement, 3.6× latency, 1.6× tokens vs :8902 chat-JSON (W225)                                                                        |
| 2026-10-02 | Jev as first-hit classifier  | 62.6% single-question phishing (beri.net); only decomposition + fitted weights reached 95%; see bench-questions.md decision-model protocol |

## Condense/enhance matrix (W367.3, blam-condense/1)

Owner directive 2026-10-05: the prompt IN/OUT variant matrix, benched on the
local swarm. Arena harness (sealed manifest `6253f5092545542e`, nonce-cold,
temp 0, AC power throughout), 6 classes × n=12 × 2 local legs = 144 cold
requests per variant. Legs: `stack-engine-local` (:4100 LiteLLM → local-\*)
and `local-direct` (raw :890x); the enhance transform rides the :4000 router
→ :890x. Class → model map: b → :8901 coder, c+e → :8902 extract,
a+d+f → :8903 reason. Engine: blam canonical condense, CONDENSE_VERSION
`blam-condense/1` (tier in the transform version); `condense-out` is the
politeness tier applied to the sealed input AS IF response-side — it
simulates the buckle `condense-in` sideband's character; the arena measures
model output quality under a gentled prompt, the real sideband is a buckle
runtime concern. The legacy arena condense id (`ref-condense/1`) is not part
of the owner matrix; its historical numbers keep their run-ids.

Run-ids (results in `packages/belt/bench/arena/results/`, gitignored;
reports per run + `variants-report.md`):

| variant              | transform version                           | run-id                    |
| -------------------- | ------------------------------------------- | ------------------------- |
| none                 | none/1                                      | 20261005T152307Z-ce658f25 |
| condense-in          | blam-condense/1/caveman                     | 20261005T154444Z-421c943e |
| condense-out         | blam-condense/1/politeness                  | 20261005T162149Z-9d583bd1 |
| enhance              | enhance-router/1                            | 20261005T201022Z-84037d00 |
| condense-in+enhance  | blam-condense/1/caveman+enhance-router/1    | 20261005T201859Z-5a8497ca |
| condense-out+enhance | blam-condense/1/politeness+enhance-router/1 | 20261005T202840Z-bee69071 |

Honesty: quality at n=12/class is **insufficient** (no claims, fleet law);
the quality direction is still reported as measured. **Load confound**:
variants none/condense-in/condense-out ran during heavy fleet contention
(row load1 12–58, several `polluted` p95/p50 flags); enhance and the combos
ran in a quiet window (load1 ~6–9). Absolute walls are NOT comparable across
that boundary — token and pass% columns are load-independent. One HTTP error
row (condense-out, class c) scored 0 and is counted. An incomplete duplicate
condense-out run (20261005T170734Z-9d583bd1, 24 rows, not ended) is excluded.

### :8901 local-coder — class b (n=24 per cell, both legs pooled)

| variant              | wall p50 SEL | wall p50 DIR | tok in/out (mean) | pass% b [measured] |
| -------------------- | -----------: | -----------: | ----------------- | ------------------ |
| none                 |        1,539 |        1,373 | 89 / 104          | 71%                |
| condense-in          |        2,543 |        2,509 | 89 / 107          | 75%                |
| condense-out         |        4,364 |        3,310 | 88 / 103          | 75%                |
| enhance              |        2,486 |        2,640 | 114 / 345         | **8%**             |
| condense-in+enhance  |        2,661 |        2,997 | 114 / 407         | 17%                |
| condense-out+enhance |        3,137 |        2,478 | 114 / 345         | **8%**             |

### :8902 local-extract — classes c, e (n=24 per cell)

| variant              | wall p50 SEL | wall p50 DIR | tok in/out (mean) | pass% c / e   |
| -------------------- | -----------: | -----------: | ----------------- | ------------- |
| none                 |          457 |          459 | 213 / 46          | 100% / 75%    |
| condense-in          |          450 |          449 | 213 / 46          | 100% / 75%    |
| condense-out         |          953 |        1,011 | 213 / 45          | 96% / 75%     |
| enhance              |          394 |          435 | 201 / 106         | **38%** / 58% |
| condense-in+enhance  |          424 |          453 | 201 / 91          | **17%** / 54% |
| condense-out+enhance |          412 |          466 | 201 / 93          | **21%** / 54% |

### :8903 local-reason — classes a, d, f (n=24 per cell)

| variant              | wall p50 SEL | wall p50 DIR | tok in/out (mean) | pass% a / d / f        |
| -------------------- | -----------: | -----------: | ----------------- | ---------------------- |
| none                 |        6,067 |        6,377 | 5,645 / 230       | 96% / 92% / 100%       |
| condense-in          |        4,770 |        4,363 | 5,645 / 174       | 100% / 92% / 100%      |
| condense-out         |        7,056 |        6,964 | 5,645 / 167       | 96% / 92% / 100%       |
| enhance              |        3,788 |        3,251 | 5,715 / 436       | **0%** / **25%** / 75% |
| condense-in+enhance  |        3,197 |        3,975 | 5,710 / 457       | **0%** / **25%** / 83% |
| condense-out+enhance |        3,597 |        3,395 | 5,710 / 449       | **0%** / **13%** / 75% |

Prompt chars in→out (transform dimension, load-independent): the caveman and
politeness tiers are near-neutral on these sealed task texts (d 328→327,
c 573→569, e 92→92); enhance INFLATES them 2–5× (e 92→457, a 179→614,
d 328→478, f q 83→374) while dropping constraints — see findings.

Findings (as measured, n=12 smoke-level):

1. **Both deterministic blam tiers are quality-neutral at this n** — pass%
   identical to none within noise on every class (the one condense-out c
   cell lost a row to an HTTP error, not a checker miss).
2. **enhance (local-LLM rewrite via :4000) collapses quality** while making
   prompts 2–5× bigger: b 71→8%, c 100→38%, a 96→0%, d 92→25%. The small
   swarm models cannot honor the enhance system prompt's verbatim rules.
3. **Combos do not rescue it** — condense before enhance lands in the same
   collapsed band (b 8–17%, c 17–21%, a 0%).
4. Out-token means on :8903 drop 24–27% under the condense tiers and roughly
   double under enhance — but class d token spread is wide (leg means differ
   660 vs 428 inside one run), so treat token deltas as suggestive only.
5. Verdict for the stack: keep the deterministic caveman tier as the inbound
   default (quality-neutral, zero added latency, audit list intact); do NOT
   enable the enhance pass on the local swarm for task prompts, and keep the
   buckle outbound sideband (politeness) default OFF pending a quality bench
   on real responses. W368 re-benches all three blam tiers per model.
