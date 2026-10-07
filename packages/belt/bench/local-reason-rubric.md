# local-reason rubric — W532 review-task grading (frozen 2026-10-07)

Frozen BEFORE the sealed run: this file's sha256 is written into the run's
seal row (`rubric_sha`). Grading is blind: grade the files in `blind/` only —
`key.jsonl` stays closed until every answer is scored. The rubric, the
anchors, and the pass line below are fixed; post-hoc reinterpretation is a
protocol violation.

## Task contract (what the models were asked)

Critically review `lane-liveness.ts` (287 lines shown, the lane-liveness
oracle shared by three consumers): correctness bugs, false-positive/negative
liveness paths, performance traps (it runs every dispatch cycle), API sharp
edges. Numbered findings, each with severity (high/med/low), quoted line,
failure mode, fix. Explicitly told NOT to pad.

## Dimensions (applied per answer, blind)

- **D1 correctness (0–3)** — findings describe real failure modes in the
  shown source; quotes match the source.
- **D2 specificity (0–2)** — quote + named failure mode + concrete fix per
  finding; vague "consider adding tests" padding scores 0.
- **D3 depth (0–2)** — at least one non-obvious issue beyond the surface
  (examples of the non-obvious class: per-lane process-table respawn, memo
  eviction order, negative-scan cost, unknown-null propagation, bounded
  staleness windows).
- **D4 no-false-positives (0–2)** — no invented lines/APIs; claimed bugs are
  bugs. Fabricated evidence caps D4 at 0 and the answer at 4/9.

Total 0–9. **Pass ≥ 6/9.** Strong = 8+.

## Ground-truth anchors (the grader checks the shown source, not memory)

A real review can note (non-exhaustive, verified against the shown file):

- **A1** `laneProcessIdentity` spawns a fresh `ps -axo pid=,args=` per lane
  per probe (the inspector is re-created per call) — O(lanes × processes)
  process-table scans every dispatch cycle; `psArgs()` exists but the
  inspector path does not share it.
- **A2** `transcriptMemo` is positive-only, FIFO at 64 entries (insertion
  order), not LRU; a churned memo rescan is the same cost as no memo.
- **A3** negative transcript lookups always rescan (by design — freshness)
  up to the 50k budget; dead lanes pay the walk on every probe.
- **A4** `worktreeLive` runs a full `ps` + `lsof` over ALL harness pids per
  call — again per dispatch cycle.
- **A5** foreign-host lanes live on transcript freshness alone; staleness is
  bounded by the 15-min reclaim lease (documented tradeoff, not a bug —
  flagging it as "high" is a false positive).
- **A6** `isHarnessProcess` null (unknown) vs false (absent) contract:
  unknown never authorizes retirement — a sharp edge, med at most.

## Procedure

1. Grade each `blind/anon-NN.md` on D1–D4 with one-line justifications.
2. Tabulate totals; pass = ≥6.
3. THEN open `key.jsonl`, map anon → leg/round, and join pass/wall/tokens
   with the round rows in `<run>.jsonl` for the benchmarks.md row.
4. Review-task quality = pass share per leg over the graded, non-void rounds
   (identity/truncation voids excluded from quality, included in the
   denominator report).
