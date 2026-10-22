# fleet benchmarks

All curated benchmark results live in this file at the fleet root. Package
documents hold protocols and question sets; do not start new results files. One curated row
per model/probe/setup, few params, medians decide — not an LLM dump.

**Do not store benchmark results in other .md files** — update this table instead.

Laws (fleet-wide): run on **AC power only** (never battery); medians over
N≥12 unless noted; speed rows are solid, quality rows need ≥130 paired
questions (33 → ±15 pts, 130 → ±7, 530 → ±4) — anything smaller is a smoke
test; score per class, never blended; one lever at a time; re-run after any
model bump.

---

## Lane effort — classification-driven two-stage vs uniform pin (W1140, 2026-10-22; design evidence, fleet A/B pending W1140.1)

Decision the row supports: pin SUSPENDERS_LANE_EFFORT by verification need
(classify rules in machine conf), never uniformly. Source numbers are
external — SlopCodeBench (via claude.dev/blog/spending-your-effort, read
2026-10-22): verification-shaped tasks gain hugely from effort (security
64→87%, hardware 34→75% low→max) while wrong-approach tasks get WORSE at
max (wrong-reading failures 25→47) and a detailed spec converges effort
levels. Fleet posture after 1b88d58a (dispatch --dry-run over the live READY
pool, 2026-10-22): verification-tagged W1094/W1141 → high; research
W1075/W1143 → medium; unmatched items → two-stage default (implement low
with the brief front-loading spec completeness, verification rides its own
classify:high lane — W1140.1 is the first such item). The fleet-side A/B vs
the W776 attribution ledger is W1140.1's acceptance, not this row.

## 2026 agent-management layer: build-don't-adopt (W1133, 2026-10-22; design evidence, no fleet probe applicable)

Decision the row supports: for the agent-management operator layer
(boards, isolation, review, recovery), extend fleet rather than adopt any
surveyed tool (Vibe Kanban, Conductor, Claude Squad, Nimbalyst, Superset,
Paneflow, Sculptor, Xum/Mux, Opcode, tmux-DIY). Source is external —
nimbalyst.com/blog/best-agent-management-tools-2026 (vendor post) +
GitHub-API/README verification 2026-10-22; comparison table, lift-list
and reject-list in docs/research-agent-management-tools-2026-10-22.md.
Fleet is at parity on organization/isolation/review; four gaps worth
building, ranked: inline diff-comment → lane feedback loop, remote-hub
lane runtime, container-per-lane enterprise tier (policy-pack overlay,
W775 arch), session replay from existing work-graph/coord events. Fleet
A/B: none applicable to a landscape survey; re-evaluation trigger = a
surveyed tool ships proof of remote-lane execution or replay UX in
production use.

## W960 harness self-improvement smoke (2026-10-20; AC)

The W958 loop ran one propose/probe/compose step, then three distinct private-judged
tasks (`cfg-create-01`, `bugfix-01`, `script-io-01`) at the pinned Fleet revision
`9d2ddb90`, using `glm-5.3-flash` through the local Belt route. Both arms
started from that revision. The editor returned a candidate, but the executor
produced empty patches on every held-out task; baseline and candidate each
passed **0/3** judges. Claude's JSON reported **zero usage tokens** for every
call, so token savings and cache efficiency are **unmeasured**. The loop
correctly refused promotion. This is a pipeline smoke failure, not a quality
comparison or an estimate of model efficiency. The private receipt is under
`~/.claude/local-llm/blam/w960/runs/364ba7e1-3e41-40ee-86f8-19d03f03cd85`.

A direct CLI reproduction showed a denied Write call with the normal Claude
configuration. With a clean config, the same model narrated a file write but
produced no file. The local route continued to report zero usage. BLAM now
treats zero usage as missing accounting; a full 130-case run waits for an
executor that demonstrably writes files and reports positive token usage.

### Independent Codex executor smoke (W960.2; AC; three paired tasks)

The same three task statements, frozen revision, and private judges ran with
`codex exec --ephemeral` using `gpt-6-luna`. The editor still used the local
GLM route; editor token usage is not reported. BLAM's Codex parser now treats
`cached_input_tokens` as part of `input_tokens`, avoiding double counting.
Reported totals include cached input, so they are usage totals, not billed
fresh tokens.

| Starter | Private judges | Reported tokens, 3 tasks | Cache-read subset | Executor wall time |
| ------- | -------------: | -----------------------: | ----------------: | -----------------: |
| Current baseline | 3/3 | 639,818 | 545,024 | 48.6 s |
| Generated candidate | 2/3 | 755,674 | 652,544 | 57.0 s |

The candidate used 18% more reported tokens and 17% more wall time, and failed
the script I/O judge. Its patch included an unrelated file from the probe task,
which is evidence that task-specific probe content leaked into the generated
starter. BLAM refused promotion; no shared starter changed. Three tasks are a
smoke test, not the required 130-task quality estimate. The private receipt is
under `~/.claude/local-llm/blam/w960/runs-codex/c3621f91-e421-4cdd-be83-70dd7e2810f0`.

---

## Supervisor coordination regimes (W977.2, 2026-10-20; deterministic)

The [supervisor coordination suite](packages/blam/bench/supervise/scenario.md)
compares three supervisor regimes on a matched 9-item/3-supervisor work set
(3 shared scopes = the C4 double-writer risk) under calm/pressure capacity
and injected consult-channel delivery. Deterministic BLAM numbers — modeled
costs, not observed LLM usage.

| Regime | dup units | claim conflicts | oversub lane-min (pressure) | consult calls | consult tok | drop-all |
| --------------------- | ---: | ---: | ---: | ---: | ---: | --- |
| independent           |    3 | 0 (never claims) | 30 | 0  | 2,100 | unchanged (never consults) |
| coordinated-bounded   |    0 | 0 | 0  | 9  | 1,080 | dup=0, conflicts=3, oversub returns |
| coordinated-unbounded |    0 | 0 | 0  | 21 | 2,520 | dup=0, conflicts=3, oversub returns |

The decision: bounded consult captures the whole coordination gain —
identical outcomes to unbounded at ~half the consult volume — so the
W977.1 supervisor contract should bound asks per decision (1 combined
claims+capacity ask, retry budget 2). The transactional claims ledger is
the correctness backstop when consults cannot be delivered (drop-all:
no duplicate work survives, efficiency degrades to blind-claim
conflicts and lost capacity compliance).

## Consult plane — live expert round trip vs verified reuse (W934.2.2, 2026-10-20)

The [live consult bench](packages/blam/bench/consult/live.md) spawns the
real coord CLI consult ladder against a scratch governor plane (scripted
expert stand-in, no model calls) and runs two matched arms over the same
questions: a full expert round trip (route → reply → asker-verified
feedback) vs the same ask after verification landed (plane-answered KB
reuse).

| Arm | answered | mean | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| expert round trip | 4/4 | 212 ms | 203 ms | 232 ms |
| KB reuse (no live lane) | 4/4 | 78 ms | 77 ms | 80 ms |

The decision: asker-verified reuse answers the repeat question ~2.7×
faster than re-routing to a live expert on the same plane, with 4/4
reproducibility properties — the verified-reuse ladder (W604/W934.2.1)
is the routing default it claims to be. Latencies are subprocess-spawn
dominated (two CLI boots per round trip vs one per reuse ask); the
same-plane ratio is the signal, not the milliseconds.

## BLAM — coordination controls (2026-10-19 rerun)

The deterministic [consult](packages/blam/bench/consult/scenario.md) and
[paired-arm](packages/blam/bench/paired/scenario.md) suites both passed 6/6
properties on this run. They simulate coordination policies; their token and
time counts are modeled costs, **not observed LLM usage**. Keep them separate
from live agent results below.

| Paired simulated case | Quality on → off | Tokens/rep on → off | Blocked min/rep on → off |
| --------------------- | ---------------: | ------------------: | -----------------------: |
| Condense              |      1.00 → 1.00 |         724 → 1,039 |                    0 → 0 |
| Consult contract      |      0.75 → 0.63 |         330 → 2,400 |              16.5 → 73.5 |
| Steer delivery        |      1.00 → 0.75 |       1,640 → 3,000 |                  20 → 45 |
| Bounded resume        |      1.00 → 0.95 |      6,000 → 16,150 |                    1 → 6 |
| Long resume           |      0.75 → 0.85 |     22,000 → 16,150 |                    1 → 6 |

The long-resume control is deliberately worse: for a large changed context,
fresh orientation is the simulated winner. The separate W768 live orientation
smoke (2026-10-15, n=3) observed cold median 76.6 s / 49,752 fresh tokens
versus forked starter 15.8 s / 1,659 fresh tokens with 97% cache share. That
small live run supports the default Claude starter fork; it is not a general
quality or cost estimate across tasks.

### Relay coding pilot (W922, 2026-10-19; AC; one held-out task × 3 pairs)

The new [BLAM Relay fixture](packages/blam/bench/agentic/README.md) has three
synthetic repairs drawn from recent Fleet failure classes: stale claim release,
cache support/reads/writes, and W3C trace propagation. Evaluated agents see
only the broken fixture and public contract; a separate 22-check oracle stays
outside their worktree. Control scores: original 7/22, reference 22/22.
Each arm starts from the same fixture commit and uses `gpt-6-luna` through
ephemeral `codex exec` with the same tool access; arm order alternates. These
are **agent harness smoke measurements**, not an end-to-end deployed Fleet or
Buckle test. Repeating one task three times does not meet the ≥130 paired
question quality rule.

| Treatment vs its paired solo control | Oracle score       | Reported total tokens/arm, mean | Cache-read tokens/arm, mean | Wall seconds/arm, mean | Result                          |
| ------------------------------------ | ------------------ | ------------------------------: | --------------------------: | ---------------------: | ------------------------------- |
| Plain solo                           | 22/22 → 22/22      |   260.7k → 375.9k (compact map) |             114.3k → 171.9k |            24.2 → 27.2 | No score gain; +44% tokens      |
| Plain solo → fresh reviewer          | 22/22 → 22/22      |                 269.0k → 937.4k |             121.5k → 438.0k |            20.8 → 69.3 | No score gain; +248% tokens     |
| Plain solo → three module agents     | 22/22 → 19/22 mean |                 260.0k → 652.1k |             118.9k → 302.5k |            25.3 → 18.2 | One 13/22 failure; +151% tokens |

None of the three treatments was promoted. The split arm passed 22/22 twice
but scored 13/22 once; its mean was 19/22, while all three matched solo arms
passed. It did shorten mean wall time by 7.1 seconds under this setup, but
that does not compensate for the quality failure. The first split attempt was
invalid: BLAM trimmed the final newline from `git diff`, causing `git apply`
to reject the patches. The raw-patch fix and regression test landed before
the reported rerun; `/tmp/blam-relay-split-w922` is the invalid receipt and
`/tmp/blam-relay-split-fixed-w922` is the valid one. Cache-read accounting is
the executor's reported token usage, not a controlled cache-off arm; all
treatments also reported zero cache-write tokens. Provider cache effects were
measured separately in the W864 on/off rows below. Full local receipts and
patches from these pilots are in `/tmp/blam-relay-context-w922` and
`/tmp/blam-relay-review-w922` and `/tmp/blam-relay-split-fixed-w922`; they are
not committed because patches can
contain task content. The base fixture commit for both was
`4979a0d86f3ef7f32eff70245a6ce37e75d0d585`.

## Knowledge retrieval — stamped-mechanical vs stamped facts+kb, FROZEN corpus (W956 round 2, 2026-10-19)

Round 2 of the W949 A/B on the W952 freeze protocol: the transcript
snapshot was sealed BEFORE question selection (seal `e3c32249ac55`,
2026-10-19T20:40:37Z, bench-lane eras excluded — zero self-echo
possible); the ten questions are W949's, verbatim, and predate the
freeze. Arms both carry confidence stamps (W953/W955 schema): A =
facts+kb read through the band-filterable lens — reality: zero banked
rows carry a rating, so the filter was a no-op; B = decant stamped
{rating 0.4, provenance mechanical:decant, freshness fresh} (decant
v0.11.0 has no native rating; the stamp is fleet-side). Identity-blind
seeded placement, two recorded judge runs, ties shown as ties, raws
kept. Judge anomaly handled per recorded rule, not silently recomputed
(see the bench README). Protocol, arms, answers, judge raws:
[packages/suspenders/bench/w956/](packages/suspenders/bench/w956/README.md).

| Metric                                  | A: stamped facts+kb    | B: stamped decant (0.4)                                        |
| --------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| Coverage                                | 2/10 (J2, J3)          | 10/10                                                          |
| Judge picks (2 stable runs, seed 956)   | 0                      | 8 (ties J2/J3)                                                 |
| Telemetry completeness (GT rubric)      | 0/5                    | 5/5 judge-scored (T1's GT accepts either view; T3's cache-rate stays a surface gap — the one fact-backfill target) |
| Read cost per question                  | 0.5–1.2 KB + discovery | ~1.6 KB targeted `ls --project` / ~5.5 KB `search --json`      |
| Layer cost                              | zero sync (pre-banked) | one-time 4.1 GB index over the frozen claude corpus (CPU-capped long passes; codex months skipped — no question material) |

**Verdict (v2): mechanical-first HOLDS on clean data, now with measured
teeth.** Stamped-mechanical sweeps preference (8/2/0) AND answers the
judgment class J1/J4/J5 at full quality with zero bench-lane echo; the
facts layer answers only the two banked lessons (J2/J3, ties at 5/5) at
~17× cheaper per-hit reads — its rent is the distilled judgment cache.
The residual surface gap is now exactly located: per-request counts and
cache-rate are ledger reads decant cannot serve — that tail, not the
sweep, is the fact-backfill target. Confidence stamps moved nothing measurable: until the banked corpus
carries ratings, band-filterable discovery is theoretical. Policy:
mechanical-first, fact-backfill only for the ledger-only metrics;
bank judgment lessons, never telemetry numbers. This row supersedes
round 1's verdict wording (W949, corrected W952) — the "pending a
re-bench on a frozen corpus" condition is now discharged, verdict
confirmed.

## Fleet attribution validity — decant cross-check (W943, 2026-10-19)

Decision: can the fleet report's TOKENS/CACHE/OUT-MIN columns (W776:
buckle-ledger `router_usage` ⋈ claim windows) be trusted, vs an independent
recount of the same transcripts by decant (local-first, Apache-2.0)?
Method + full per-lane table:
[docs/decant-crosscheck-2026-10-19.md](docs/decant-crosscheck-2026-10-19.md).
Runner: `bun packages/suspenders/scripts/decant-crosscheck.ts --by-sid`
(read-only on ledger + graph + decant index).

| Comparison (7d, fleet lanes)                  | Result                                          | Verdict                                            |
| --------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| Fronted lanes, closed sessions (267 sid rows) | per-lane fresh/cached/out agree within **±1–3%** | **TRUST** the W776 columns for fronted lanes       |
| Pre-Oct-19 lanes (cache era gap)              | ledger cache ≈ 0 (0.77k–1M/day) vs transcripts 90–99% share; front reports 858.8M on Oct 19 | **CORRECTION-NEEDED**: CACHE column undercounts ~90+ pts for claims before the Oct 19 fix |
| Non-lane keys (keepwarm 4.4k req, watchdog 3.0k req) | no claim window → excluded               | attribution join doing real work; raw ledger not lane-only |
| Live lanes at run time                        | −15..−21% (transcript flush lag)                | artifact, not drift                                |

Drift causes (top-3): pre-Oct-19 cache-invisibility era on the buckle
front; non-lane probe keys sharing the ledger; constant +15–16k
bootstrap-sized fresh surplus per lane (first hop off-front, ~0.05% at
fleet scale). decant's parse verified exact vs a raw unique-id recount;
transcript usage rows MUST be deduped by `message.id` (raw-line sums
double-count ~2×).

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

Question: does the fleet stack beat pure llm API access? Sealed harness
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

### Prompt cache on/off (W864, 2026-10-19; n=12 medians, AC)

Runner: `bun bin/bench-suite.ts --cache --port <p> --model <id>
--wire openai|anthropic [--cache-control] --reps 12 --sizes 2000,8000`
(`bin/bench-cache.ts`). Local `:890x` = miss (fresh nonce) vs hit (fixed
streamed prefix) — rapid-mlx has NO per-request cache control; the prefix
cache is always-on, capability read from `/metrics` + usage
`cached_tokens`. Cloud via buckle `:4101` = off (no cache_control) vs on
(`cache_control: ephemeral`, rep 1 writes, rest read).

| Leg                       | 2000 tok miss→hit ms | read | 8000 tok miss→hit ms | read | Verdict                                             |
| ------------------------- | -------------------: | ---: | -------------------: | ---: | --------------------------------------------------- |
| :8903 reason 35B-A3B      |             407 → 73 | 1760 |           1622 → 101 | 7296 | always-on prefix cache 5.6×/16× TTFT; 21.4GB active |
| :8901 coder 30B-A3B       |             346 → 35 | 1677 |            1806 → 79 | 6876 | 10×/23× TTFT; 16.8GB active                         |
| :8902 extract 4B          |             352 → 30 | 1677 |            1653 → 75 | 6876 | 12×/22× TTFT; 2.8GB active                          |
| glm-5.3-flash (z.ai)      |          1488 → 1247 | 1536 |                    — |    — | cache_control honored, −16% wall                    |
| zai-glm-5.3-flash         |          1051 → 1090 | 1536 |                    — |    — | cache_control honored (read reported), no wall gain |
| claude-sonnet-5 (Copilot) |          1135 → 1233 | 1536 |                    — |    — | cache_control honored (read reported), no wall gain |

Verdict: the local always-on prefix cache is the decisive cache win —
10–16× warm TTFT at 2k–8k prefixes at zero request cost. Cloud
`cache_control` is honored everywhere and reads are reported (1536 of the
2000-token prefix), but at these prefix sizes wall latency gains are
inconsistent (one leg −16%, two flat) — don't pay for cache hops at 2k.

W922 reran the `:8902` extract leg on AC on 2026-10-19 with the same 2k
prefix and n=12. Current model:
`mlx-community/Qwen3-4B-Instruct-2507-4bit`; miss→hit median TTFT
**298→29 ms**, usage cache-read **16→1,677 tokens**. The 16-token miss read
shows incidental overlap; it is not a forced cache-off request. Rapid-MLX
has no per-request cache switch on this wire, so this is a fixed-prefix
versus nonce-cold comparison. The result corroborates the earlier 352→30 ms
row under this run's load; it does not isolate provider cache writes or agent
session cloning.

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

## Routing — fixed-tier vs complexity-v3 (W745, 2026-10-18)

Route_audit-derived replay: buckle `route_audit` (gate placements +
end-to-end durations + transport ok) + belt routing log (router-side
specialist records) over a 7-day window — 30,059 routed requests, n≥12 ✓
medians strong for measured cells. Runner: `bun packages/belt/bin/bench-routing.ts --days 7`
(read-only, no behavior change; repeatable — same flags, window re-derived
at run time). Audited arm = real per-request outcomes; fixed arms re-place
every request to one tier and price latency from the SAME window's measured
placement medians (tier-matched for the cloud arm); the fixed:cloud token
volume scales the measured window volume by the request share (the ledger
records no tokens for local rides — estimate, labeled).

| Arm                        | done% | local% |    p50 |    p90 | cloud tok in/out (Mtok) | $/1k tasks |
| -------------------------- | ----: | -----: | -----: | -----: | ----------------------- | ---------- |
| complexity-v3 (audited)    |  99.5 |   15.1 | 4.65 s |  8.1 s | 133.3 / 10.3            | $-n4       |
| fixed:reason (all → :8903) | 100 † |    100 | 1.13 s |  9.6 s | 0 / 0                   | elec ($0)  |
| fixed:cloud (all → :4100)  |  99.8 |      0 | 5.11 s | 5.11 s | 157.1 / 12.2 (est)      | $-n4       |

† transport completion (HTTP ok), not answer quality — quality A/B is
eval-models.ts's contract, not this bench's. fixed:reason is excluded from
the choice: one specialist (maxInflight=1) absorbing the full window queues
bursts, and ok ≠ quality on hard asks.

**Verdict: complexity-v3 routing** — completion parity (±0.3 pt) with
−25.7 Mtok/7d cloud volume (−15.2%, est) and p50 9.0% lower than
fixed:cloud; the local 15.1% rides the swarm at elec with p50 163 ms
placement latency (:4000) vs 5.1 s cloud. $-claims stay gated: the ledger
carries no operator price table — abstain ($-n4) until
`~/.claude/local-llm/route-prices.json` (`--prices`) exists.

## Review pipeline — single-pass vs how-to-review pipeline (W792, 2026-10-18)

Seeded-defect A/B on the local reason tier (:8903, GLM-5.3-Flash). 39
sealed tasks: 24 seeded across 13 defect classes × 10 generator families +
3 real fleet incidents (reverse-of-fix diffs, ca301352/95cbc90f/fd7025d) +
12 clean files; ground truth = seeded defect lines ±5. Harness:
`bun packages/belt/bench/arena/review-run.ts --design/--run/--report`
(seal sha16 `05578c7b2a3391ed`). Both arms 39/39 calls ok, AC power,
2026-10-18. n=39 → **weak** band (33–129); local-only, no cloud leg.

| Arm                   | recall | FP/task | human noise/clean | converged ≤3 | verdict acc* | tok-in p50 | calls p50 | wall p50 |
| --------------------- | -----: | ------: | ----------------: | -----------: | -----------: | ---------: | --------: | -------: |
| A: single-pass oracle |   100% |    0.49 |              1.58 |         1/39 |          67% |        190 |         1 |    1.3 s |
| B: review pipeline    |    94% |    1.03 |              3.08 |        20/39 |          74% |      2,673 |         7 |   14.3 s |

\* outcome-corrected: on defect tasks a PASS after a recall>0 fix counts
correct (found-and-fixed); the only wrong verdict is PASS with zero
detection (A: inc-w663 false-PASS; B: inc-w663 + seed-06).

Read: recall at par (100% vs 94%); the pipeline's fixer leg CLOSED 14/27
defect tasks (found → confirmed → triaged → fixed → re-review clean) —
closure arm A has no mechanic for — at ~14× tok-in (p50 2,673 vs 190), 7×
calls (p50 7 vs 1) and 11× wall. The pipeline also DOUBLES human noise on
clean files (3.08 vs 1.58 findings/task the human must read). 6/39 arm-B
tasks ended in honest reviewer format-miss FAILs: the local tier's finding
vocabulary drifts per request (high:file:line / CRITICAL( / severity(high):
/ prose), and ~50% of reviewer rounds miss the machine-parseable format;
retry ×3 often returns byte-identical output (temp-0 determinism is
per-process, not per-boot).

**Verdict: keep single-pass as the review gate** — recall par at ~1/14th the
cost and half the noise. The pipeline's unique value is CLOSURE (fixer +
verified re-review) — adopt it as a post-detection repair loop, not a
pre-merge reviewer; it needs a format-compliant reviewer tier before its
recall/FP numbers mean anything on small local models.

Deviation notes: triage rides the extract tier (kev :8912 speaks the
SystemOne wire, not openai chat); fixer rode :8903 via REVIEW_FIXER_PORT
(coder tier down at run time). Per-task rows + call traces:
results/rev-w792-final-{a,b}.jsonl (gitignored, machine-local).

## Prompt transforms — bench local swarm (W368, 2026-10-16)

Which specialist should serve the board's prompt transforms — the
deterministic blam `caveman` condenser (incumbent compress), `local-extract`
(:8902, W288 incumbent enhance head), `local-coder` (:8901),
`local-reason` (:8903)? n=130 seeded prompt pairs (seed 20261016,
`packages/suspenders/scripts/lib/prompt-bench-corpus.ts` — verbose/terse
pair per seed, protected tokens known by construction), nonce-cold legs,
deterministic scorer (retention 5/6 + key words 1/6, identifier-addition
guard, transform secondary), no LLM judge. Production client semantics
(max_tokens 400, verbatim ENHANCE_SYS, `<think>` strip). Direct legs on
the :890x OpenAI wire (the path `resolveEnhanceTarget` takes) + one :4000
router lane (router's own placement; it placed all 130 enhance legs on
:8902). AC power. Manifest: `packages/belt/bench/benchmarks.jsonl` (suite
`prompt-transform`); per-leg NDJSON in `.fleet/prompt-bench/` (untracked).

Quality rows at n=130 → ±7 pts per fleet law; gaps below that are NOT
separable. Walls are CROSS-CONTAMINATED (the three direct lanes ran
concurrently on one GPU; the router lane ran solo afterwards) — speed
shape only.

| Transform | Target        | n   | score mean | ret p50 | ratio p50 | add p50 | wall p50 | Verdict                                            |
| --------- | ------------- | --- | ---------: | ------: | --------: | ------: | -------: | -------------------------------------------------- |
| compress  | blam caveman  | 130 |       94.0 |   1.000 |     0.689 |       0 |     0 ms | incumbent; deterministic, offline, zero latency    |
| compress  | coder :8901   | 129 |   **96.5** |   1.000 |     0.555 |       0 | 1,599 ms | best LLM compressor; ≤±7 of blam = not separable   |
| compress  | extract :8902 | 129 |       94.8 |   1.000 |     0.520 |       0 |   900 ms | reformats tokens (`--trace=` style), invents flags |
| compress  | reason :8903  | 129 |       92.6 |   1.000 |     0.589 |       1 | 2,032 ms | add p50=1: invents identifiers per leg             |
| enhance   | extract :8902 | 130 |   **99.6** |   1.000 |     1.354 |       0 |   842 ms | **best enhancer** — fastest direct + top score     |
| enhance   | reason :8903  | 130 |       99.3 |   1.000 |     1.421 |       0 | 1,092 ms | tie with extract within ±7                         |
| enhance   | coder :8901   | 130 |       95.9 |   1.000 |     1.392 |       0 | 1,151 ms | occasional token-dropping rewrites (score-42 tail) |
| enhance   | router :4000  | 130 |       99.1 |   1.000 |     1.351 |       0 |   478 ms | placed 130/130 on :8902; solo-run wall, see note   |

Picks: **best compressor = local-coder :8901 (as LLM leg) — but the
deterministic blam caveman stays the production condense** (no separation
within ±7 that justifies a per-prompt model call + residency); **best
enhancer = local-extract :8902 — the W288 default alias order is
CONFIRMED**, no knob change. Operator override pins (gateway mode, verified
live): a quality leg = `SUSPENDERS_PROMPT_MODEL=local-reason` (buckle group
→ litellm → :8903; a raw `mlx-community/...` id does NOT pin — unknown ids
ladder to the extract tier via the default ladder) or router placement =
`SUSPENDERS_PROMPT_ENHANCE_URL=http://127.0.0.1:4000/v1/messages` —
documented in packages/suspenders/docs/board-api.md (`prompt.enhance` row).

## Chat tiers — M5 Max 128GB (fleet medians, 2026-09-23)

| Port | Role           | Model                       | GB  | tok/s (median) | Verdict                                                     |
| ---- | -------------- | --------------------------- | --- | -------------- | ----------------------------------------------------------- |
| 8901 | code           | Qwen3-Coder-30B-A3B-4bit    | 18  | 123.7          | current coder tier                                          |
| 8902 | extract/menial | Qwen3-4B-Instruct-2507-4bit | 2.5 | 158.9          | fastest port in fleet                                       |
| 8903 | reason/best    | Qwen3.5-35B-A3B-OptiQ-4bit  | 22  | 123.6          | best quality×speed — OptiQ +25% same-day (W228, 2026-10-03) |
| 8906 | danish/general | Qwen3.5-9B-MLX-4bit         | 5   | 85.2           | on-demand                                                   |
| 8913 | rerank         | Qwen3-Reranker-0.6B         | 0.5 | —              | rank-only (22ms p50): acc@0.5 4/10 — see reranker section   |

## Measured A/B results

| Comparison                                                                                                      | Result                                                                                                                                                                                                                                                                           | Verdict                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MoE 35B-A3B vs dense Qwen3.8-27B                                                                                | 147.9 vs 28.3 tok/s (5.2×)                                                                                                                                                                                                                                                       | MoE wins at equal quality                                                                                                                 |
| bf16 KV vs int8 KV (Coder-30B)                                                                                  | 107.4 vs 87.3 tok/s                                                                                                                                                                                                                                                              | bf16 KV wins                                                                                                                              |
| rapid-mlx 0.14.3 vs mlx_lm.server (code, Coder-30B)                                                             | 121.8 vs 91.9 tok/s (+33%)                                                                                                                                                                                                                                                       | rapid-mlx runner wins                                                                                                                     |
| rapid-mlx vs mlx_lm.server (reason, dense 27B)                                                                  | 29.5 vs 24.8 tok/s (+19%)                                                                                                                                                                                                                                                        | rapid-mlx runner wins                                                                                                                     |
| Qwen3.5-35B-A3B-OptiQ vs -4bit (same model, W228)                                                               | 107.2 vs 86.0 tok/s (+25%)                                                                                                                                                                                                                                                       | OptiQ takes the :8903 slot                                                                                                                |
| Engine swap (Coder-30B, mlx_lm → rapid-mlx)                                                                     | 97.4 → 123.7 tok/s                                                                                                                                                                                                                                                               | biggest single lever so far                                                                                                               |
| GLM-5.3 reasoning pin vs unpinned (W770, legacy leg :4100, zai-glm-5.3, 9528-char diff-review brief, 3k budget) | effort-low = stop=stop, 2559 out (1305 reasoning), 4990-char review, 40.1 s vs unpinned = 3000/3000 thinking-only, content 0 chars, 46.1 s; anthropic-carrier alias row (glm-5.3) rejects reasoning_effort with litellm 400 — the forward lives on the zai openai-wire rows only | pin is LIVE on :4100 zai rows (post-activation A/B 2026-10-15) — pin the escalate legs; :4101 kickstart still picks up the buckle forward |

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

| Date       | Model                                  | Verdict                                                                                                                                         |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | Qwen3.8-27B (dense)                    | 28.3 vs 138.5 tok/s at equal probe quality — the :8903 slot stays Qwen3.5-35B-A3B                                                               |
| 2026-09-27 | GLM-5.x locally                        | 204–418GB at 4-bit; no fit in 128GB — remote-only                                                                                               |
| 2026-09-27 | Xing4.0-29B-A4B                        | MLA+MTP unproven in MLX, no expected edge over Qwen3.5-35B-A3B                                                                                  |
| 2026-09-27 | Fastino-Nemotron-3.5-Lightning-Finance | English-only; no Danish context — general local model + own docs wins                                                                           |
| 2026-09-27 | Intern-Decision-4B                     | 12/15 vs 13/15 fork replay, CUDA-only serving; revisit only if an MLX port appears                                                              |
| 2026-10-02 | kev-4B as belt fit-classifier          | 4/12 agreement, 3.6× latency, 1.6× tokens vs :8902 chat-JSON (W225)                                                                             |
| 2026-10-03 | Qwen3.5-9B-OptiQ-4bit                  | 68.5 vs 87.0 tok/s re-benched same-day (load1 ~9.7) — :8906 stays 9B-MLX-4bit, weights deleted                                                  |
| 2026-10-19 | RavenX-Qwen3.6-35B-A3B MTP-4bit        | 132.1 vs 128.4 tok/s vs the :8903 incumbent — TIE inside ±5% margin; MTP edge unproven at 35B in MLX, OptiQ slot stands, weights deleted (W242) |

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

## Prompt-variant matrix × model set (W282, 2026-10-15)

Owner-directive 2026-10-05 matrix re-run across the model-set dimension
(glm | local | kev | mixed × none | condense-in | condense-out | enhance).
Arena sealed manifest `6253f5092545542e`, nonce-cold, temp 0, AC power
throughout, sequential rounds, n=12/class. Baseline none×glm (pure-api
reference); every leg pairs per task against it; δ=0.10 non-inferiority with
n<33 ⇒ no claims. Baseline deltas mix TRANSFORM and BACKEND capability for
local/kev/mixed legs (no same-day none×local baseline) — transform-isolated
local reads need the W367.3 same-day local rows. 1,332 measured rows cited
across 13 runs; enhance×local class b has NO data (coder-tier :8901 starved
all three attempts — see honesty notes).

### Run-ids (ts 20261015T153116Z prefix elided; results gitignored)

| variant      | glm        | local      | kev        | mixed      |
| ------------ | ---------- | ---------- | ---------- | ---------- |
| none         | `0ec075cc` | —          | —          | —          |
| condense-in  | `5e959eb0` | `421c943e` | `6fd25423` | `cf74f174` |
| condense-out | `c08ff583` | `9d583bd1` | `09ed4b81` | `80fa0b10` |
| enhance      | `7c68aa82` | `84037d00` | `b65ced01` | `6aa7ab90` |

enhance×local assembled from TWO partial runs (both EXIT 0, classes
e/d/a/c/f clean in both): `153116Z-84037d00` + `183005Z-84037d00`; class-b
attempt `190500Z-84037d00b` served 1/24 rows. The three broken class-b
blocks (24+24+23 error rows, "Internal error during streaming" on :8901
direct and via :4100) are excluded from tables.

### pass% per class (n=12/class/leg; stack-router e-leg is a placement probe, excluded)

| transform    | set   | a   | b   | c   | d   | e   | f   |
| ------------ | ----- | --- | --- | --- | --- | --- | --- |
| none         | glm   | 33  | 100 | 100 | 100 | 100 | 100 |
| condense-in  | glm   | 33  | 100 | 100 | 96  | 100 | 100 |
| condense-in  | local | 100 | 71  | 100 | 92  | 75  | 100 |
| condense-in  | kev   | —   | —   | —   | —   | 83  | —   |
| condense-in  | mixed | 100 | 58  | 100 | 83  | 83  | 100 |
| condense-out | glm   | 42  | 96  | 100 | 96  | 100 | 100 |
| condense-out | local | 92  | 71  | 100 | 92  | 75  | 100 |
| condense-out | kev   | —   | —   | —   | —   | 83  | —   |
| condense-out | mixed | 100 | 58  | 100 | 83  | 92  | 100 |
| enhance      | glm   | 4   | 54  | 0   | 71  | 100 | 92  |
| enhance      | local | 0   | —   | 2   | 75  | 75  | 100 |
| enhance      | kev   | —   | —   | —   | —   | 83  | —   |
| enhance      | mixed | 8   | 0   | 0   | 67  | 75  | 100 |

Cells pool both legs per class (err rows counted as fail; stack-router
e-probe excluded; kev legs are class-e-only). Baseline a=33% is the hardest
cell (glm cloud, cold, n=12 — noise floor).

### Deltas vs none×glm baseline (pooled cells; Δq CIs leg-level from the variant report)

- **condense-in / condense-out: quality-neutral everywhere measured.** Every
  Δq 95% CI straddles 0 on every leg of every class except noise-band dips
  (d −0.083…−0.333 at n=12; b −0.135…−0.313 on local-scale cells).
  Deterministic chars deltas: d −0.3%, c −0.6%, e/f 0.0% — caveman and
  politeness stay near-neutral on these sealed texts, matching W367.3.
- **enhance on c is a TRANSFORM failure, not a backend failure.** 0–2% pass
  on EVERY backend including cloud (glm pure-api 0%, stack-anthropic
  claude-sonnet-5 0%, local tiers 2%) with Δq ≈ −1.000 — the rewrite takes
  the extract schema 573→193 chars (−66%) and the contract is gone.
  W367.3's local-only 100→38% understated it: the rewrite itself destroys
  the task.
- **enhance collapse generalizes beyond the local swarm.** glm a 33→4%,
  b 100→54%, d 100→71% (7 truncated-fallback prompts) — with prompt
  INFLATION (a 179→616 chars +244%, b 303→457 +50%, e 92→151 +64%).
  W367.3 blamed the small swarm models; today's data shows cloud models
  fail the same way.
- **enhance on f is the one clean win**: the rewrite SHRINKS q1/q2
  83→14 chars (−83%) and quality HOLDS (92–100% pass on every backend,
  Δq −0.083…0.000) — tiny-field rewrites are the only measured-safe
  enhance surface.
- **Speed**: local legs run 0.04–0.19× the glm-cloud walls on a/b/c/e
  (5–25× faster, all CIs exclude 1.0); class f long-context is the
  exception — local 1.19–1.28× SLOWER than glm cloud (3.9s vs 2.8s p50).
  kev-direct e-walls 288–509ms (0.10–0.20×). Contention inflates local
  walls (honesty notes) — treat wall ratios as ceiling estimates.
- **stack-anthropic (claude-sonnet-5 via :4100)** holds 100% on a/f,
  83–92% on d/e, but 58% on b code-gen — behind glm cloud (100%) at these
  settings; stack-router e-leg 8% is the by-design max_tokens-1 placement
  probe.

### Honesty notes

- Load confound: the coder tier :8901 was saturated ~2h by concurrent fleet
  lanes (Metal 33.3GB vs 23.5GB D-METAL-CAP, max_concurrent 2, no queue) —
  local walls carry contention; quality cells unaffected except the missing
  enhance×local b. 1 transient err row (enhance×glm pure-api socket drop)
  counted as fail, W367.3 precedent. 8 enhance-cache truncation prompts
  (e008 + 7×d) fell back to sealed prompts, flagged per row — 16 fb rows in
  EVERY enhance round (8 prompts × 2 legs), 4 rounds + 2 partials.
- enhance×local b: 3 attempts, 71/72 requests errored — "Internal error
  during streaming" (:8901 direct and via :4100). NEED_DECISION #42040
  (bd6947f) carries the capacity question: a 2-slot, no-queue coder tier
  starves under any concurrent lane load; bench-grade runs need a quiet
  window or a reserved slot.
- Judge pass (W748) not run — quality signal is mechanical-only at n=12.
