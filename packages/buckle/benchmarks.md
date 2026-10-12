# buckle benchmarks — probe/question pinning

Fleet verdict rows (decision-grade) live in the ONE root table:
[../../benchmarks.md](../../benchmarks.md) (owner law, 2026-10-05: one
file, fleet root). This file pins buckle's probe/question text so results
stay comparable — the executable source of truth is code (probes in
`bin/onboard.ts --verify`, gate benches in test/). Sample-size law
(beri.net, 2026-10-02): 33 questions →
±15pts, ~130 → ±7, ~530 → ±4; repeats kill model noise, not
question-sampling noise; below ~300 datapoints the normal approximation
underestimates. Suites labelled _smoke_ are exactly that. Quality
(model-swap) rows run through [bin/eval-models.ts](bin/eval-models.ts)
(W424) — the powered paired harness; protocol below.

## Wire pings (connectivity smoke)

One ping per wire, run by `bin/onboard.ts --verify`; a wire is "serving"
only when the answer is non-empty and the model id is the pinned one.

- **openai chat**: POST `<base>/chat/completions` — "Say READY", max_tokens 5, temperature 0 → expect 200 + non-empty content.
- **anthropic**: POST `<base>/v1/messages` — same body shape claude CLI sends; expect non-empty text block.
- **responses wire**: POST `<base>/responses` — codex-style input; expect non-empty output_text.
- **github_copilot via engine**: chat/completions with `model="github_copilot/<model>"` through :4100 → expect non-empty (W219.1 acceptance).

## Decision-model protocol (Jev / kev / hosted decision APIs)

The shared protocol lives once in the fleet root table:
[../../benchmarks.md](../../benchmarks.md) (§7 — beri.net full evaluation,
2026-10-02).

## Model-swap eval (W424 protocol) — bin/eval-models.ts

The powered paired A/B harness for routing/lane-model changes; this file
pins the protocol so runs stay comparable.

- **Paired, seed-pinned tasks**: both arms run the IDENTICAL list — ≥130
  tasks per shape (code/menial/reasoning/danish; `--n`, seed default 424).
  `--quick` (n=8) is a wiring smoke, never a verdict.
- **Computed answer keys** — never hand-typed: math/sequences/extraction/
  JSON keys derive from the generator's own inputs; Danish number words
  come from the shared formatter; code snippets carry `meta.code`, and
  `test/eval.test.ts` executes every snippet under node:vm against the
  computed key (mirror drift fails loudly).
- **Per-shape report, never blended**: Wilson 95% per arm + exact McNemar
  on the paired discordants. Owner abstain rule: overlapping intervals =
  tie → cost per resolved task decides (`--price-in/out-a/b`); without
  prices the eval abstains honestly.
- **Repeats** (`--repeats k`, majority per task) fix model noise only —
  never question-sampling noise. Latency p50 per arm is recorded.
- Machine report (one JSON line) on stdout, human table on stderr,
  per-task JSONL via `--out`. Verdicts feed routing-policy.yaml, belt
  prefs, and dispatch model pins — operator-owned files; the harness
  never writes them.
