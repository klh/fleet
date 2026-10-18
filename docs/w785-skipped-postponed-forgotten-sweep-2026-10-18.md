# W785 — skipped/postponed/forgotten sweep (2026-10-18)

Owner-approved review lane (read-only, no code edits). Surfaces:
`doesnt_work.md`, `.klh-done.md` (repo root — the brief's `docs/.klh-done.md`
path is stale; no such file), coord facts, the NEED_DECISION event log, and
the condition-gated items. Every claim re-verified against the work graph and
this worktree's HEAD on 2026-10-18. Baseline: the 2026-10-12 triage
(`docs/failed-backlog-triage-2026-10-12.md`) — deltas since then are the focus.

## Condition-gated items

| Item | Verdict | Evidence |
| --- | --- | --- |
| W695.6.1 retry-after cap | **landed** | DONE, `3d1a3596` (cooldown cap); W784 re-verified live |
| W242 MTP re-bench | **still-open (active)** | NOT forgotten: lane ran today — RavenX 22.58G all 5 shards downloaded 18 Oct 19:03, bench blocked by the AC-power owner law (`fleet-refresh.ts:84`); decisions #44222/#44224 open, AC-gated cron armed |
| W738 Copilot re-run | **still-open (gated, at risk)** | FAILED + gate ~2026-11-01. FAILED has no reclaim path — unless `work retry W738` is armed at quota lift, the re-run is silently dropped. Follow-up minted: W804 |

## Silently forgotten

1. **FAILED tail has no retry cadence** (W731 lead 5, still true). ~35 FAILED
   rows; among them stale-landed work nobody closed: W369 (preview landed:
   `routes-orch.ts` `/api/orchestrate/preview` + `board-html/klh-prompt-preview.ts`
   + vendor build), W722 (intent `inspect|fail` verb landed,
   `dispatch-next.ts:177-286`), W279.1 (superseded by W279 `aa51eede`, verified
   by W725). `work retry` exists (44092cbb) — nothing sweeps the tail. → W805
2. **W454 multi-harness starters, remainder lost**: W768 landed the claude leg
   only; codex/copilot/gemini/grok legs and the advice.25427-ruled re-mint
   never executed. Item still FAILED. → folded into W805
3. **W584 work-reap verb never built**: `work.ts` has only subscribe/idle
   reaping (rg, no worktree-reap verb). 52 local `parked/*` refs + ~40
   worktrees accrete; W695.8 (6/7 children DONE, only .6 W165 re-integration
   outstanding) archives parked refs but the standing verb remains unbuilt.
4. **W772.1 hygiene notes never actioned**: `skills/local/SKILL.md:14-15`
   port drift persists (says 8912 classifier; registry: 8912 kev; 8906/8907/
   8913 missing); repo-root `.agents/` stale untracked skills copy still
   present; `packages/suspenders/skills-lock.json` untracked leftover. → W806
5. **W730 verify-or-refute** (W708 scrub-gate diff parser, pre-hunk metadata):
   died in 8m, never retried; the claimed parser hole is unadjudicated.
6. **Operator-side deploy notes unverified from lane**: W616.1 SSE-reframer
   "live on next install.sh sync + spoke kickstart"; W658.3 landing-chain
   steps — gitleaks half is resolved (fingerprint in `.gitleaksignore:62`).

## Postponed (READY, unclaimed, aging)

- **W539.1** IKEA health-policy pilot — deps all DONE/SUPERSEDED, claimable,
  untouched. Largest dormant READY item; owner-scope heavy.
- **W718** DRY/decompose `dispatch-next.test.ts` — the file is 1429/1500;
  every new test adds PATCH-FIRST strand risk. Delayed = costlier.
- **W792 / W795** small READY pool (oracle A/B, `work show` multi-id).

## Live NEED_DECISION backlog (open, evidence-checked)

- #44222/#44224 — W242 AC-gate (cron armed; supersedes expired #44181/#31342)
- #44197 — fleet-enterprise gitleaks full-history (59 findings); blocks
  W688.6 → the whole NAS-flip chain (W493.3/W632 ancestry)
- #44185 — W484.1 NAS-token probe; default (b) if owner stays silent
- #44221 — wisdom C1 stub fill (W179.2 title/desc)

## Verified landed since the 2026-10-12 triage (no action)

W695.6.1 · W695.3.7 ladder-merge (`8e6163c8`) · W658.3 gitleaks blocker
(`.gitleaksignore:62`) · W725/W279 e-labels · W768 starter forks ·
W784 coherence sweep (PASS + W801-W803).

## Obsolete

- `docs/.klh-done.md` as a path (ledger lives at repo root `.klh-done.md`).
- W369 / W722 / W279.1 **as work** — landed; need close-with-note, not rework.

## Follow-ups minted this sweep

- **W804** (p1) arm W738 retry at quota lift ~2026-11-01
- **W805** (p2) stale-FAILED close sweep W369/W722/W279.1 + W454 disposition
- **W806** (p3) skills-catalog hygiene (port drift + stale untracked copies)

Tooling note (no item): `coord fact list` truncates at ~38KB alphabetically
(no prefix filter) — full lesson.*/finding.* catalogs are not enumerable from
the CLI face today.
