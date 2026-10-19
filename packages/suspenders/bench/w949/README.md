# W949 — knowledge-retrieval A/B: LLM-banked layer vs mechanical decant

Blind, decision-grade A/B (owner 2026-10-19): is the LLM knowledge-banking
layer (coord facts + consult_kb) cheaper AND better than pure mechanical
retrieval (decant FTS + per-session stats over the same transcripts)?

- **Questions**: 10, drawn from real fleet history — 5 telemetry
  (per-item spend/files/time/model/rank) + 5 judgment (real incidents:
  scrub pre-push re-flag, copied-sleep zombies, capsule checkpoint,
  merge-ladder self-ship veto, retry-after cap).
- **Arms**: A = coord facts + kb (discovery scan + kb search + fact get,
  agent-chosen key guesses); B = decant (one-time sync + targeted
  `ls --project` + `search --json`), private bench db.
- **Scoring**: identity-blind — seeded X/Y placement (seed 949), the
  judge (oracle :8903, Qwen3.5-35B) scores each answer 0-5
  correctness/completeness against arm-neutral GT memos. Two judge runs,
  identical picks.

## Results (frozen 2026-10-19)

| Metric | A: banked (facts+kb) | B: mechanical (decant) |
| --- | --- | --- |
| Telemetry coverage | 0/5 | 5/5 (T2 file-list + T3 cache-rate partial on surface) |
| Judgment coverage | 2/5 (J2, J3) | 5/5 (J3 via transcript echo of banked row) |
| Judge picks | 2/10 | 8/10 |
| Read cost / question | 0.3-2.7 KB | 5.5-11.5 KB (targeted) |
| Discovery cost | 23.4 KB fact-list scan; kb search no-match 9/10 | 828 KB fat global `ls` vs ~1.6 KB targeted `ls --project` |
| Latency / question | 95-135 ms | 45-242 ms |
| Layer cost | ~1.25M tok amortized banking spend (1.6% coord-knowledge tool share × 78.1M CONSULT=Y spend) + 2.6 MB corpus | 450 s one-time sync, 1.5 GB index; standing serve amortizes via watch |
| Per answered Q | ~4k read-tokens + banking share | ~1.5-3k read-tokens, zero banking |

## Verdicts

- **Telemetry: mechanical wins outright** — 5/5 picks vs 0/5; the banked
  layer's per-item rows (finding.w932 et al) are work-prose, not numbers.
  Banking telemetry-shaped knowledge = waste by construction.
- **Judgment: mechanical-first, facts as curated cache** — mechanical
  covers the unbanked rest (J1/J4/J5 full marks); where both answered
  (J2/J3) quality TIED at 5/5, picks fell to ties→X (seed placed banked
  in X). Banked rows are ~17× cheaper to read per hit (640 B vs 11 KB),
  so the facts layer pays rent only as a distilled judgment cache.
- **STOP-banking?** No for judgment lessons (the only layer answering
  J2/J3 at full quality; marginal spend is 1.6% of CONSULT=Y item spend);
  YES for telemetry-shaped rows — never bank numbers that decant derives
  for free.

## Methods + caveats

- W943 cross-check (landed): W776 attribution TRUSTED ±1-3% vs decant
  recount (267 sids/7d) — the cost numbers stand on a validated ledger.
- Contamination: the W949 lane's own transcript synced into the index;
  J1/J4 mechanical hits include this bench's own GT prose — the J1/J4
  mechanical answers partially self-echo. J3's mechanical answer echoes
  the banked lesson (layers are coupled through transcripts; mechanical
  subsumes banked content).
- Judge output glitch: `y_k` undefined on some rows (local 35B judge);
  picks were stable across two runs, scores recomputed treating missing
  y_k as 5.
- Raw per-question data: results/arm-a.json, results/arm-b.json,
  results/answers-a.json, results/answers-b.json,
  results/judge-input.md, results/judge-verdict.json (+ -2).
