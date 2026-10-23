# W1172 — matched review-agent eval protocol (gate-held)

How the fleet measures whether the W1144 review-skill change improves real
held-out review quality. Everything here is reproducible; the answer key and
the judge rubric are machine-local private material.

## What it measures — and what it may never claim

- **Measures**: matched before/after review-agent runs over a held-out
  corpus with a private judge scoring planted-issue recall and false
  positives, plus executor token/cost totals.
- **Never claims**: an improvement from text/regex documentation fixtures,
  from usage counts, or from the harness existing. No quality claim exists
  until the gated matched batches run (see Gate).

## Arms

| arm | rev | skill bytes |
| --- | --- | --- |
| before | `b0cd7fb6` (pre-W1144) | `git show b0cd7fb6:skills/review/SKILL.md` (21 lines) |
| after | `HEAD` of the eval branch | same path |

The skill text is the ONLY variable: identical ask, file bytes, model,
settings, judge, route. Arms resolve through `resolveArm` (byte-exact,
sha-pinned in the receipt).

## Corpus

`tests/review-eval/corpus.ts` — six held-out targets with issues planted
from a closed class vocabulary (off-by-one, pipe-to-tail, sqlite-null-guard,
empty-env-knob, arg-null-zero, unverified-claim, secret-in-source,
unbounded-buffer), plus `t5` (clean control, zero planted issues). Task
bytes are bench artifacts: never import them into product code, never cite
them as documentation. The planted-issue INVENTORY (class/line/severity per
task) is machine-local private judge material — never committed, never sent
to the review agents.

## Machine-local pins (`~/.claude/local-llm/blam/w1172/`, mode 0600)

| file | role |
| --- | --- |
| `inventory.json` | answer key: issue class @ line per task (validated against the corpus by the runner) |
| `judge-prompt.md` | private judge rubric with the answer key inlined |
| `executor-settings.json` | claude `-p` settings pin (tool denies, hooks off) |

Judge route pin: local reason tier `http://127.0.0.1:8903/v1/chat/completions`,
wire model id `mlx-community/Qwen3.5-35B-A3B-OptiQ-4bit` (live `/v1/models`
id, 2026-10-23). Runner env: `W1172_JUDGE_KEY`, `W1172_JUDGE_MODEL`.

## Modes

```sh
# zero-load: validate pins, spawn nothing (always allowed)
W1172_JUDGE_KEY=… W1172_JUDGE_MODEL=… bun tests/review-eval/run.ts --plan

# gated: matched batches + private judge + 0600 receipt
W1172_GATE=open … bun tests/review-eval/run.ts --run
```

- `--plan` exits 0 only when files exist, the inventory fits the corpus,
  both arms resolve, and the judge env is present.
- `--run` exits 2 with the gate message unless `W1172_GATE=open` — checked
  in `main` AND in `runMode` (defense in depth); no out dir is created.
- Judge leg: one bounded attempt per output; failure records `score: null`
  instead of guessing. Judge tokens are not metered (common-mode overhead).

## Receipts

`runMode` writes `~/.claude/local-llm/blam/w1172/runs/<runId>.json`, mode
0600, never committed: runId/ts, gate marker, corpusSha, task ids, both arm
receipts (rev, commit, skill sha256), pins (executor/settings/judge
url+model), per-run records (exit, duration, output, usage, cost, judge
score) and per-arm totals (found/planted/falsePositives + tokens + cost).

## Gate (owner ruling, NEED_DECISION #59314 → ANSWER #59851)

`W1172_GATE=hold` until the W1124 productive-rollout verification (30-40
productive lanes) closes. Zero-load harness only until then. At gate-open,
the run procedure is: `--plan` green → `--run` → keep the 0600 receipt →
record found/planted/FP and token/cost per arm in benchmarks.md → only then
may a positive or negative outcome be recorded. The registry row (PENDING)
and the follow-up item hold this until then.
