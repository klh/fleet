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

One ping per recipe, run by `bin/onboard.ts --verify` (local targets
only — a non-local `--base-url` is refused in verify mode); a wire is
"serving" when the probe comes back alive.

- **anthropic** (claude recipe): POST `<root>/v1/messages` — 1-token
  "ping" body (`max_tokens: 1`) → expect status < 500.
- **openai family** (codex / copilot recipes): GET `<base>/models` → any
  status < 500 means the gateway is alive; 401/403 = alive but
  auth/config problem, reported, not fatal; 404/410 = no such route, a
  hard fail.

The W219.1 engine acceptance (chat/completions with
`model="github_copilot/<model>"` through :4100 → non-empty answer)
remains the recorded acceptance bench for the litellm-as-engine seam;
`--verify` does not run it.

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
