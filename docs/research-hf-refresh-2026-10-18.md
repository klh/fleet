# HuggingFace refresh research — swarm specialists (2026-10-18)

W793, research-only: no swaps, no config changes. Source of truth audited:
`packages/belt/bin/registry.ts` @ `bd6947f`. All facts pulled from the HF API
(`huggingface.co/api/models/...`) and model cards on 2026-10-18. Size
estimates for MLX 4bit use ~0.56 bytes/param — verify with `huggingface-cli
download --dry-run` before any bench. Owner law: an A/B on the bench rig
precedes any registry edit.

## Slot-by-slot

### :8901 coder — `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit`

Current quant created 2025-07-31 (base `Qwen/Qwen3-Coder-30B-A3B-Instruct`),
dl 20.5k. Base family unchanged since; **Qwen3-Coder-Next** (2026-01-30) is
the generational successor: 80B total / 3B active, 512 experts / 10 active,
hybrid Gated-DeltaNet + gated attention, 262,144 native context, non-thinking
only, Apache-2.0. Card claims performance comparable to models with 10–20×
more active params; built for coding agents (long-horizon tool use, recovery).
MLX quants: `Qwen3-Coder-Next-4bit` (dl 6.1k), 5/6/8bit, mxfp4/nvfp4/mxfp8
(2026-05-06). ~45 GB at 4bit vs 18 GB today.

- **Verdict**: highest-upside swap candidate in the fleet. Same active-param
  class (3B) so latency should hold; cost is RAM (+27 GB) and an unproven
  512-expert qwen3_next path on the rapid engine.
- **Next step**: bench-suite A/B (SWE-task set + tok/s, rapid engine) on
  `Qwen3-Coder-Next-4bit`; keep 30B-A3B if throughput regresses.

### :8902 extract — `mlx-community/Qwen3-4B-Instruct-2507-4bit`

Current quant created 2025-08-06 (base `Qwen/Qwen3-4B-Instruct-2507`), dl
45.7k — the oldest instruction model in the registry. In-family refresh:
**Qwen3.5-4B** (2026-02-27), natively multimodal (image-text-to-text),
262,144 native context (extensible to 1,010,000), 201 languages, Apache-2.0.
MLX quants: `Qwen3.5-4B-MLX-4bit` (dl 39.8k) and `Qwen3.5-4B-OptiQ-4bit`
(dl 10.8k), both 2026-03. ~2.7 GB at 4bit — same RAM class as today.

- **Verdict**: cleanest refresh of the seven. Same slot budget, newer gen,
  adds vision (screenshot extraction) for free. Qwen's card benchmarks
  Qwen3.5-4B against GPT-OSS-20B / Qwen3-30B-A3B-2507 — no published
  head-to-head vs Qwen3-4B-Instruct-2507, so the uplift is unproven for our
  JSON-shaping workload.
- **Next step**: extract-bench A/B (`Qwen3.5-4B-OptiQ-4bit` vs current) on
  the standard extraction corpus; OptiQ variant first (W228 precedent).

### :8903 reason — `mlx-community/Qwen3.5-35B-A3B-OptiQ-4bit`

Current quant repo modified 2026-07-14 (sha `d2418dfe`) — fresh; OptiQ
re-quant already adopted (W228). No newer in-family mid-size. Ceiling option:
**Qwen3.5-122B-A10B** (2026-02-24, Apache-2.0) with official
`mlx-community/Qwen3.5-122B-A10B-4bit` (dl 5.5k) — ~69 GB at 4bit: fits a
128 GB M5 Max only as an on-demand experiment tier, not resident alongside
the current set.

- **Verdict**: hold. Verify the local weights cache is at revision
  `d2418dfe` (repo was touched after many fleet caches were pulled); otherwise
  no change. 122B-A10B is a quality-ceiling experiment, not a swap.

### :8906 danish/general — `mlx-community/Qwen3.5-9B-MLX-4bit`

Current quant modified 2026-03-23 (dl 31.8k). Danish-ecosystem scan:
**munin-qwen3.5-9B** (`danish-foundation-models`, 2026-06-01) — post-trained
from the same `Qwen/Qwen3.5-9B-Base`, Danish-focused, text-only, Apache-2.0;
benchmarks at foundationmodels.dk (Munin 1.0 release note 2026-06-11). No MLX
quant published (dl 141) — self-quant via `mlx_lm.convert` is trivial.
**DFM-Mimir v1.5** (2026-09-23) — Danish-first 1.79B HRM-Text XL PrefixLM,
instruction-tuned, Apache-2.0 — but trained at 4,096-token context on an
exotic arch with unknown MLX support.

- **Verdict**: no swap. `munin-qwen3.5-9B` is the only same-size A/B
  candidate; low adoption + external benchmark page argues verify-before-bench.
  Mimir = watchlist (4k context rules out our general slot).

### :8907 embed — `mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ`

Current quant created 2025-06-06, unchanged since (dl 29k); served by
context-rag's `embed_server.py` (mlx_embeddings). Candidates:

- **google/embeddinggemma-2** (2026-09-14, Apache-2.0): 740M total / 270M
  text backbone, unified 768-d space (text+image+video+audio), 8k context,
  MRL to 128/256/512d. MTEB multilingual v2 61.36 (≈ par with v1 61.15);
  **code NDCG@10 78.68 vs 68.76 (+10)**. MLX quants 2026-10-06 (bf16/8/6/5/4bit,
  mxfp4/8, nvfp4). MTEB text-parity means the win is code + MRL storage.
- **Qwen3-VL-Embedding-2B** (2026-03-13): 2.1B, 32k ctx, 2048-d,
  instruction-aware, multimodal; mlx 4bit exists. Heavier, same-family.

- **Verdict**: candidate — our indexes are mostly TypeScript repos, and the
  +10 code NDCG plus MRL dims (4× vector-storage cut at 256d) target exactly
  that. Two gates before any A/B: (1) `EmbeddingGemma2Model` support in
  mlx_embeddings/embed_server.py (unverified), (2) 8k-vs-32k context vs our
  chunk sizes.

### :8912 kev — `jaredpalmer/kev-4b`

Current: Kev 1.0, card-pinned revision `139fdd94` (published 2026-09-24),
base `Qwen/Qwen3.5-4B-Base` — registry already reflects 1.0. Repo was touched
2026-10-01 after the card pin (metadata-level; card still says 1.0 = main).
Locked-test accuracy 0.838 / brier 0.224. Family now spans 0.5b–27b
(`kev-27b` 2026-09-24) — all System One-style typed classifiers.

- **Verdict**: hold. Action items are cache hygiene only: verify the local
  weights match `139fdd94` at next maintenance. `kev-27b` (~3× RAM) is not
  justified by a routing-classifier slot with 0.838 accuracy.

### :8913 rerank — `mlx-community/Qwen3-Reranker-0.6B-4bit`

Current quant repo re-created 2026-06-06 (9 files, dl 1.4k) — a re-upload of
the 2025 quant; note for cache freshness if ranking output ever shifts.
Candidates: **Qwen3-VL-Reranker-2B** (2026-01-07, 2B, 32k ctx, 30+ langs,
multimodal, instruction-aware; mlx 4bit dl 172) — adds modality we don't
rerank; **jina-reranker-v3** (2025-09-18, dl 936k) — CC-BY-NC-4.0
(non-commercial) and mxfp4-only on MLX; **mxbai-rerank-large-v2** — no fresh
small quant.

- **Verdict**: hold. Text-only doc rerank at 0.5 GB is well-served; every
  candidate either adds unneeded modality, carries an NC license, or lacks
  quant maturity.

## Watchlist (appeared <14d, unbenchmarked)

- `mlx-community/DeepSeek-V4.1-Flash-1017-oQ4e-mtp` (2026-10-17, 129B, MIT)
  — reason-tier ceiling experiment if active params + tok/s verify large.
- `mlx-community/LFM2.5-24B-A2B-OptiQ-4bit` (2026-10-16) — 2B-active MoE;
  license tag `other` (Liquid) — check terms before bench.
- `mlx-community/Ternary-Bonsai-2-{2,4,9}B-2bit` (2026-10-15) — 2-bit ternary;
  quality unproven, watch for MLX momentum.
- `mlx-community/embeddinggemma-2-*` quants landed 2026-10-06 — see :8907.

## Cache-freshness checks (no action beyond verification)

| Registry repo | HF revision | Local cache? |
|---|---|---|
| Qwen3.5-35B-A3B-OptiQ-4bit | `d2418dfe` (mod 2026-07-14) | verify |
| Qwen3-Reranker-0.6B-4bit | `5f324548` (2026-06-06 re-upload) | verify |
| jaredpalmer/kev-4b | card pins `139fdd94` (2026-09-24; repo mod 2026-10-01) | verify |

Verify: `huggingface-cli download <repo> --dry-run` (or check
`~/.cache/huggingface` revision dirs) — pulls only if stale.

## Summary

| Slot | Action |
|---|---|
| :8901 coder | A/B `Qwen3-Coder-Next-4bit` — highest upside |
| :8902 extract | A/B `Qwen3.5-4B-OptiQ-4bit` — cleanest refresh |
| :8903 reason | hold; verify cache at `d2418dfe` |
| :8906 danish | hold; `munin-qwen3.5-9B` is the only A/B candidate |
| :8907 embed | gate on mlx_embeddings support, then A/B `embeddinggemma-2-4bit` |
| :8912 kev | hold; cache check vs `139fdd94` |
| :8913 rerank | hold |
