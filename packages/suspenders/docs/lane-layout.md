# Lane layout law (W1139.2)

The lane prompt is composed in ONE stable order — global (system + tools) →
project (AGENTS.md, read by the agent at runtime) → session (lane identity +
brief) → messages — and the SHARED layer never carries churn. A timestamp, a
per-lane sid, or a machine-local path inside the shared prefix makes every
lane re-pay the full prefix cold. Source doctrine: Anthropic's prompt-caching
lessons (source read 2026-10-22), fleet-mapped onto the starter-seed surface.

Enforcement is BY CONSTRUCTION, in three faces (all in
`scripts/lib/lane-layout.ts` unless noted):

1. **Seed gate** — `assertStablePrefix` refuses a churn-carrying seed before
   a starter session can be versioned. Wired in `ensureStarter` beside the
   W454 `assertNoSecrets` credential guard (`scripts/lib/lane-starter.ts`).
2. **Composition filter** — `starterInstructionContext` skips promoted
   guidance rows matching `PREFIX_CHURN_PATTERN` (ISO dates, `.worktrees/`
   paths, `autow` sids, `/Users/` homes); all-churn guidance drops the whole
   block. The gate above still refuses any survivor.
3. **Continuation composer** — `continuationPrompt(base, summary)` builds the
   ~10x-cheaper retake/compaction shape: IDENTICAL shared prefix + appended
   CONTINUATION instruction, never a re-orientation. Dispatch rides it via
   `continuationPromptFor`/`resumeStartNotes` (`scripts/lib/resume-from.ts`)
   on the honored `--resume-from` path (W622 retake knob): a resumed
   transcript gets the stable prefix + summary, not a cold brief.

The `PREFIX_CHURN_PATTERN` is case-sensitive on purpose: the fixed
orientation text never upper-cases these tokens. `LAYOUT_LAW_BULLET` — the
layout-law bullet riding the shared seed — is itself churn-free (the gate
proves it at seed time; `test/lane-layout.test.ts` pins it).

Tests: `test/lane-layout.test.ts` — the pattern's hazard classes, the seed
gate, the continuation shape, the guidance-row filter and the resume notes.
Related: `docs/lane-starters.md` (the starter/fork surface the law guards).
