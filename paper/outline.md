# BLAM paper plan

**Working title:** BLAM: A Failure Taxonomy, Dataset, and Reproducible
Benchmark for LLM Agent Fleets on Shared Repositories

**Positioning:** first empirical study of how agent _fleets_ fail on shared
git repositories — the control-plane setting (work graphs, merge ladders,
leases, liveness markers). MAST covers chat-style multi-agent chat systems;
nothing covers the control-plane setting. Evidence that the gap is real:
the literature search (2026-09-29 digest, docs in the suspenders repo)
found zero peer-reviewed work on parallel agents + shared git state.

## Target venues (career-boost ranked)

1. NeurIPS 2027 Datasets & Benchmarks (May 2027 deadline) — the MAST slot;
   needs the full labeling protocol executed (second annotator, κ ≥ 0.7)
   and ≥50 records.
2. ICLR 2027 (late Sep 2026 deadline — likely missed; ICLR 2028 next cycle)
   — public OpenReview visibility.
3. TMLR rolling — no-deadline fallback with real credibility.
4. Workshop-first: agentic-coding/LM-agent workshops at the next big
   conference, 3–6 months to a priority marker.

## Outline

1. **Introduction** — fleets write to shared repos at scale; coordination
   failures are undocumented; we contribute taxonomy + dataset + bench.
2. **Related work** — MAST (chat-MAS failures), CodeCRDT (shared-artifact
   coordination), METR (time horizons + the Aug-2026 emergent-coordination
   incident), Cognition 2025/2026 (single-threaded writes; zero-shared-
   context review), AI Control (subversion-resistant oversight), Kim et al.
   (decomposability), Anthropic multi-agent post (token economics 15×).
3. **The CRASH taxonomy** — five classes, subclasses, decision tree,
   mapping to MAST categories.
4. **Dataset construction** — incident extraction from fleet records,
   sanitization, schema, labeling protocol, agreement stats.
5. **BLAM-bench** — LLM-optional scenario design, determinism bar, the
   suspenders pre/post A/B as baseline result.
6. **Results** — seed-dataset class distribution; bench scores for the
   reference control plane pre/post fixes (measured: pre-fix fails S1/S4/S5,
   post-fix passes).
7. **Discussion** — what the CRASH distribution says about where fleets
   actually lose (recovery > races > poisoning in seed data); enforced
   coordination beats conventions (METR corroboration).
8. **Limitations** — one machine, one control plane, sanitized single-fleet
   seeds, LLM-optional scenarios don't capture model-behavior classes.
9. **Ethics & licensing** — sanitization protocol, CC-BY-4.0 data, MIT code.

## Near-term work plan

1. Taxonomy + schema + seeds + protocol (this commit)
2. Second-annotator sample (25 records min) → κ
3. Scenario harnesses for S1–S5 + pre/post A/B measurement
4. arXiv preprint + named release
5. NeurIPS 2027 D&B submission
