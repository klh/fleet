# bench/w956 — round 2: confidence-aware A/B on a FROZEN corpus

W949 round 2 (owner 2026-10-19: "make decant do that then when it ingests
and run it again"): rerun the knowledge-retrieval A/B after the mechanical
arm carries native confidence stamps and the corpus is frozen per the W952
freeze rule (ChatGPT audit #47581 + clarification #47582).

## Freeze (protocol)

- **Snapshot before everything**: claude-projects (5,605 f / 6.30 GB) +
  codex (27,136 f / 8.83 GB) cloned to `/tmp/w956-frozen-corpus2` at
  2026-10-19T20:40:37Z, seal `e3c32249ac55`
  (results/corpus-manifest.json; per-source manifests beside the snapshot).
- **Excluded**: the W949/W956 bench-lane transcript dirs (the round-1
  self-echo / fact-echo era — 9 dirs skipped) and every file written after
  the freeze instant (incl. this lane's own transcript; post-freeze skips
  recorded in the manifest). Secrets (auth/credentials/env/keys) never
  copied (34 skipped in codex).
- **Questions predate the freeze**: W949's ten, VERBATIM (finalized
  19:53Z in 07b6c3be < 20:40:37Z) — the round-2 verdict is
  decision-grade against round 1. `bun -e` check: 10 questions,
  placement coin BBAABAAABB (seed 956).
- **Scope caveat (honest)**: the fresh index covers the claude corpus
  (1,843 sessions / ~619k msgs — all ten questions' material verified
  present: W918/W918.5/W927/W932/W935 worktree sessions, the 2026-10-12
  zombie incident, W236/W944 scrub lanes) + targeted verify passes over
  the five bench-question dirs (scanned 5, skipped 5 = already
  ingested). Codex months 2026-07..10 were not ingested (no question
  material; long passes hit CPU caps — exit 152 twice at 60-90 min,
  4.1 GB index retained via upsert). Both arms read the same db scope,
  so the A/B stays internally valid.

## Arms (confidence-aware)

- **A = facts+kb with confidence stamps (band-filterable)**: coord fact
  get + kb search with the W953/W955 stamp schema
  {rating, detail, evidence, researched} recorded per used row. Corpus
  reality: **zero banked rows carry a rating** — doctrine landed, corpus
  backfill hasn't — so band-filtering is currently a no-op filter and
  arm A degenerates to the round-1 banked layer (results/arm-a.json).
- **B = stamped decant (0.4 mechanical)**: every mechanical answer row
  stamps {rating: 0.4, provenance: mechanical:decant, freshness: fresh}
  (fleet-side stamp; decant v0.11.0 has no native rating —
  results/arm-b.json).

## Scoring (round-2 rubric)

Per-key-point completeness (each covered +1 up to 5, half +0.5),
correctness 0-5 (contradiction/invention loses points), ties SHOWN as
ties (no forced pick), both judge runs recorded raw
(judge-verdict-1/2-raw.txt), identity-blind seeded X/Y placement.
Stamps stay OUT of the judge input — the A/B measures retrieval; stamps
are analyzed separately. The ChatGPT round-2 DESIGN was pending at run
time (requested via this lane's report): it can be applied as a re-score
of the frozen judge-input.md — no re-bench needed.

## Results (frozen corpus, seed 956)

| Metric | A: stamped facts+kb | B: stamped decant (0.4) |
| --- | --- | --- |
| Coverage | 2/10 (J2, J3) | 10/10 |
| Judge picks (2 stable runs) | 0 | 8 (ties: J2, J3) |
| Telemetry completeness | 0/5 | 5/5 judge-scored (T1's GT accepts either view; T3 cache-rate = the residual surface gap) |
| Read cost / question | 0.5-1.2 KB per fact hit; discovery 64 KB fact-list + 1.6 KB kb-list | ~1.6 KB targeted `ls --project` (exact project_path match) or ~5.3-5.9 KB `search --json` |
| Layer cost | zero sync (rows already banked) | one-time index over the frozen corpus (4.1 GB db retained; long passes CPU-capped) |

- **Judge anomaly (recorded, both runs)**: J4/J5 scored arm A's
  "No answer" x_c=5/x_k=5 — the 35B judge attributed the GT memo's own
  text to the adjacent empty answer (run-2 prose: "X correct (explains
  veto)"). The head prompt says "No answer scores correctness 0"; the
  recomputed rows give B 5/5 vs A 0/0 → B. Raw kept unre-written, the
  recompute is recorded in judge-verdict.json.
- **Judge input hygiene**: judge verdicts are stable across runs but the
  J4/J5 failure mode (GT-proximity attribution) is a durable bench
  gotcha — banked as a fleet lesson.

## Verdict (v2 — replaces the W952-corrected wording)

**Mechanical-first HOLDS on clean data, now with measured teeth.** The
stamped-mechanical layer sweeps preference (8 picks, 2 ties, 0 to the
banked arm) AND answers J1/J4/J5 at full quality with ZERO bench-lane
self-echo (round 1 had echo). The residual surface gap is exactly
located: per-request fresh/cached counts and cache-rate are ledger
reads mechanical cannot serve — that tail, not the sweep, is the
fact-backfill target; everything else (files, commits, models, output
rates, spans, incident mechanisms) is mechanical-first. The facts layer
answers only the two banked lessons (J2/J3, ties at 5/5) at ~17×
cheaper reads — its rent is still the distilled judgment cache.
Confidence stamps moved nothing measurable: until the banked corpus
carries ratings, band-filterable discovery is theoretical. Policy
stands: mechanical-first + fact-backfill for the ledger-only metrics;
bank judgment lessons, never telemetry numbers.
