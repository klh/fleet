# W660 — W658 shatter plan: verified (record)

W660 is the re-minted plan item for the W658 shatter (W658.1 SUPERSEDED →
W660). The shatter already materialized under W658 — W658.2/.3/.4, minted
with `why_parallel: independent-scopes` — so W660 closes as the plan record,
not a re-split. A second split would duplicate landed work.

## Scope A — console shell + pages (W658.2)

- `board-html/klh-topbar.ts` — the shared Lit topbar base (avatar dropdown,
  settings gear, `me` JSON attribute), served as `/vendor/klh-topbar.js`.
  `consolePage` / `fleet-board-html` / `usage-chrome` are thin mounts;
  `topbar()` + `TOPBAR_JS` retired incl. the openai-review-flagged
  innerHTML at the old console-html.ts:131.
- Commit: a18b4f6a (ancestor of main).

## Scope B — board SPA chunks (W658.3)

- `board-html/core.ts` + `board-html/tasks.ts` innerHTML retired
  (openai-review flags cleared); probe contracts moved with the migration
  per lesson.probe-contract-rot.
- Commit: 4596b19 (ancestor of main).

## Scope C — usage dashboard (W658.4)

- Substance already landed in main: `klh-usage-*` Lit panels
  (board-html/usage-panels.ts — tiles/actors/aids/activity/spokes, W652.3.1,
  commit dbb33f48) riding the `<klh-topbar>` mount in usage-chrome.ts
  (W658.2). Zero innerHTML in the usage trio.
- Graph state: READY but `work take` refuses — dep W657 is done-but-unmerged
  (a3367c2d lives only on parked/W657, not main). The UI migration is
  payload-driven and survives the W657 consolidation, so it does not
  actually gate on it. NEED_DECISION #37872 emitted: merge parked/W657,
  re-gate W658.4, or accept this record as done-in-effect evidence.

## Verification

merge-base --is-ancestor vs main, checked 2026-10-12: a18b4f6a ✓, 4596b19 ✓,
dbb33f48 ✓, a3367c2d ✗ (parked/W657 only). `rg innerHTML` over
usage-page-html.ts / usage-chrome.ts / usage-panels.ts / core.ts / tasks.ts:
zero hits.
