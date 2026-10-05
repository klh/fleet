# Specialty compression models — the W367.5 research (2026-10-05)

Companion to `prompt-condense-spec.md`. Question: is there a specialty
model for prompt compression that can ride LOCAL compute (M5 Max, swarm
:8901–03 via belt :4000) before anything goes to cloud? Short answer: yes
— **LLMLingua-2 mBERT** — but it is a bench variant, not the canonical
engine.

## Verdict

1. **Bench first: `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank`**
   — 178M mBERT token classifier, Apache-2.0, ~408K dl/mo. Discriminative
   token pruning distilled from GPT-4 labels: it DROPS, never rewrites —
   the closest model class to the meaning-preservation laws (L1/L3).
   Paper: 2–5x compression, 3–6x faster than causal-LM compressors,
   1.6–2.9x end-to-end acceleration (arXiv 2403.12968). M5 Max path:
   transformers+MPS via the Python `llmlingua` package behind a small
   belt sidecar (same pattern as the anthropic-shim local leg); est.
   50–150 ms per 4–8 KB brief. `force_tokens` pins structural markers —
   use it to approximate the L1 protect surface in the bench.
2. **Second: Qwen3-0.6B** (Apache-2.0, MLX-LM officially supported —
   rides the existing swarm) as the abstractive upper bound. Nondet
   (greedy banned by the model card), 2–6 s, and REWRITES — dangerous on
   machine-facing context (L2: hedges are meaning).

## Comparison

| Model             | Params                | License                                  | Method                     | M5 Max path                  | Est. 4–8 KB | Det.                   |
| ----------------- | --------------------- | ---------------------------------------- | -------------------------- | ---------------------------- | ----------- | ---------------------- |
| LLMLingua-2 mBERT | 178M                  | Apache-2.0                               | token-classification prune | transformers+MPS, py sidecar | 50–150 ms   | stable, NOT idempotent |
| LLMLingua-2 XLM-R | 560M                  | MIT                                      | same, larger               | same                         | 200–500 ms  | same                   |
| Qwen3-0.6B        | 0.6B                  | Apache-2.0                               | abstractive rewrite        | MLX-LM (:8901–03)            | 2–6 s       | no (sampling)          |
| LFM2-350M         | 354M                  | LFM Open (non-OSI, <$10M revenue clause) | abstractive                | llama.cpp; MLX unconfirmed   | 2–5 s       | no                     |
| SmolLM2-360M      | 360M                  | Apache-2.0                               | abstractive                | llama.cpp quants             | 2–5 s       | no                     |
| RECOMP            | T5-class / Flan-T5-3B | repo MIT; ckpts unlicensed               | extractive + abstractive   | transformers/MPS             | 3–10 s      | partial                |
| Selective-Context | GPT-2 124M            | MIT                                      | self-information filter    | transformers CPU/MPS         | 1–3 s       | stable @ fixed ratio   |

Not recommended: XLM-R variant now (3x compute for marginal F1 — the
upgrade path if mBERT disappoints); LFM2 (license friction vs the
enterprise direction); RECOMP (NQ-retrieval domain, wrong task);
Selective-Context (strictly dominated by LLMLingua-2).

## Determinism / integration notes

- Arena semantics (`belt/bench/arena/transforms.ts`): `deterministic:
false` transforms ride the cached class (`cacheHash` machinery
  exists); dryrun gates deterministic ones on stable + idempotent +
  never-longer.
- **LLMLingua-2 is input-stable but NOT idempotent** — pruning changes
  bidirectional context, so a second pass drops more. It must ship as
  `deterministic: false` and can never be the canonical blam engine
  (spec law L4). It is a bench VARIANT and an optional runtime leg, not
  the ruleset.
- It reintroduces a Python dependency into a Bun/TS stack — keep it out
  of the zero-dep engine entirely; sidecar only.
- All candidates run on-device: zero cloud tokens, per the owner
  directive.

## Risk

Both LLMLingua-2 checkpoints were distilled on MeetingBank transcripts,
not instruction text — the paper claims out-of-domain generalization
(LongBench, GSM8K, BBH), but W367.3's bench on real fleet briefs is the
actual verdict. Bench-first, adopt-later.

Fact pointer: `coord fact get finding.compression-models`. Sources: HF
model cards (per model), arXiv 2403.12968 / 2310.04408 / 2310.06201,
microsoft/LLMLingua, ml-explore/mlx-lm (decoder-only), mlx-embeddings
(encoder support).
