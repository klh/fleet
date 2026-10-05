# Prompt-condense: one engine, tiered rulesets, homed in blam (W367)

Status: **PROPOSED** — verdict delivered to owner 2026-10-05; consumer swaps
gate on owner ack of the blam siting. The engine work itself is
clean-room, zero-dep, and reversible.

## Verdict

Yes — situate the **canonical deterministic condense engine** in **blam**,
and have suspenders/belt/buckle consume it. Not because blam is a runtime
library today (it is a benchmark), but because:

- The consumers span three packages (suspenders board + dispatch, buckle
  outbound, belt arena) — a suspenders-lib home would force belt/buckle to
  import upward from the control plane. blam is a **zero-dep leaf**: nothing
  imports it today, it imports nothing, so the new edge
  `production → blam` adds no cycle.
- The engine is **pure and deterministic** — exactly the artifact class a
  benchmark may own. blam's own arena pattern is already
  "pluggable Transform under test"; a benchmark shipping the versioned
  reference implementation it scores is coherent (blam keeps its
  LLM-optional, CI-runnable doctrine).
- The **meaning-preservation law and the corpus that judges it belong
  together**. The eval lives in blam-bench; the engine next to it.

## Divergence inventory (the finding, 2026-10-05)

Three deterministic condensers exist today, three different grammars:

| #   | Where                                                      | Lines | Ruleset shape                                                                                                        | Verbatim protection grammar                                                          | Status                                                    |
| --- | ---------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 1   | `packages/suspenders/hooks/board/prompt-transform.ts`      | 389   | W287 politeness-only filler regexes + W334 caveman tier (meta-sentence strip, Jaccard-0.75 sentence dedupe) + tidy() | fences, inline code, URLs, paths, flags, dotted identifiers                          | PRODUCTION (board preview + dispatch briefs, default ON)  |
| 2   | `packages/belt/bench/arena/condense.ts` (`ref-condense/1`) | 150   | 30-phrase table, strips hedges (**just/very/really/simply**) + articles (the/a/an)                                   | `"""` blocks, fences, `<log>`, code, quoted strings, `<placeholders>`, FORMAT: lines | EVAL-ONLY, but labeled "reference" — **contradicts W287** |
| 3   | `packages/buckle/src/pipeline.ts` `condenseText()`         | ~60   | politeness family, but line-anchored (DROP_LINE + PREFIX_STRIP), inline-code swap/restore                            | fences, inline code (swap/restore), line-anchored rules                              | PRODUCTION (response-side `condense-in`, default OFF)     |

Also load-bearing: `packages/suspenders/scripts/dispatch-next.ts:385`
condenses the MISSION section of every dispatched brief (W334 tier at the
source) — same module as #1.

**#2 is the outlier**: its filler list violates the W287 law (hedges are
never stripped in production) while carrying the name "reference". It is
demoted to an eval-only tier in this spec.

## Why not the alternatives

- **suspenders lib** — belt/buckle would import from the control plane.
  Wrong direction; buckle is a public-facing gateway with its own test
  suite and identity.
- **A new packages/condense leaf** — a fourth package for ~400 lines is
  monorepo sprawl; blam already exists as a zero-dep public leaf and is
  the natural eval home.
- **LLM-assisted condensing in the engine** — rejected: the engine is
  deterministic-only. LLM enhancement stays the separate pluggable
  `Transform` (enhance) the belt arena already defines; a hybrid is a
  bench variant, never the canonical engine.

## The canonical module

`packages/blam/src/condense/` (zero-dep, pure, deterministic):

- `engine.ts` — protect/mask/restore machinery: the union protection
  grammar (fences ```/````, `"""` blocks, `<log>` blocks, inline code,
  quoted strings, `<placeholders>`, FORMAT: lines, URLs, paths, flags,
  dotted identifiers), mask→rules→restore pipeline, rules-fired audit
  list (buckle's `CondenseResult{text, rules}` shape, generalised).
- `tiers.ts` — tier table, tiers are DATA, not code branches:
  - `politeness` — W287 filler set (greetings/thanks/please/go-ahead,
    doubled words). Production default (board, briefs, buckle `condense-in`).
  - `caveman` — politeness **+** W334 meta-sentence strip + Jaccard-0.75
    sentence dedupe. Current dispatch briefs tier.
  - `aggressive` — the belt `ref-condense/1` phrase table + article strip,
    **eval-only**: excluded from production by law L2. Kept because it is
    the measured baseline the arena already has numbers for.
- `version.ts` — `CONDENSE_VERSION = "blam-condense/1"`; bump on any
  output-affecting change; snapshot tests pin bytes per version.

Import mechanics until W422.5 workspace wiring lands: consumers import by
repo-relative path (`../../blam/src/condense/engine.ts`); bun resolves it
directly. W422.5 converts to workspace imports; this spec's import lines
are the only touchpoints.

## Audience split (owner directive 2026-10-05)

Direction and audience pick the tier — one engine, four consumers:

| Surface                                              | Direction        | Tier                     | Why                                                                        |
| ---------------------------------------------------- | ---------------- | ------------------------ | -------------------------------------------------------------------------- |
| Dispatch briefs, board orchestrate (user → LLM)      | inbound          | `caveman`                | machines read it; condense as hard as meaning allows                       |
| AGENTS.md / CLAUDE.md / context injections           | inbound, machine | `machine` (new)          | users never read these; max condense — W367.4                              |
| LLM → user responses (buckle `condense-in` sideband) | outbound         | `politeness`             | USERS read what comes back — gentle, default OFF (W137)                    |
| Enhance pass                                         | inbound          | LLM-assisted, local-only | rides belt :4000 → local swarm :8901–03; zero cloud tokens before dispatch |

`machine` = the aggressive phrase table + article strip MINUS hedge
removal — owner bounds it "without detrimental effect", and law L2 stands:
a hedge in an AGENTS.md ("only touch X") is meaning. Eval-only status of
`aggressive` is unchanged; `machine` is its production-safe sibling.
Bench matrix (W367.3): in/out × none/condense/enhance combos, rows in the
central benchmarks.md. Specialty compressor research: W367.5.

**LANDED (W367.4)**: `condenseTier("machine", …)` in
`packages/blam/src/condense/tiers.ts` — the aggressive phrase table +
article strips + cap-resolve + belt spacing chain + exact sentence dedupe,
the belt hedge list removed (L2 stands), protected by the union grammar
(the engine's full L1 surface). Consumer seam: the board orchestrate
repo-context injection (`packages/suspenders/hooks/board/orch.ts`,
`orchContext`) — the orchestrator LLM's inbound context is condensed at
consume-time, and the preview discloses the same bytes (deterministic, L6;
the held plan materializes ctx once, so no tier-keyed cache is needed).
Dispatch-brief MISSION/INBOX stay `caveman` (row 1 of the table above).
The knowledge substitution corpora (suspenders `loadRootDocs`/`loadDocs`,
buckle `doc-skip.ts`) stay raw — they are mechanical coverage inputs for
the substitution gate, not model-facing text.

## The meaning-preservation law (executable)

1. **L1 Protect surface**: fences, `"""` blocks, `<log>` blocks, inline
   code, quoted strings, `<placeholders>`, `FORMAT:` lines, URLs, paths,
   flags, dotted identifiers — matched surface is never altered, byte
   for byte.
2. **L2 Hedge law (W287)**: hedges/quantifiers/scope words (just, maybe,
   only, very, quite, perhaps, really, kind of…) are never removed in any
   production tier. `aggressive` violates L2 by design and is therefore
   eval-only.
3. **L3 Invariants**: numbers, technical terms, imperative verbs are never
   removed.
4. **L4 Idempotence**: `condense(condense(x)) === condense(x)` for every
   tier.
5. **L5 Auditability**: every pass returns `{ text, rules }` — the board
   debug/log preview and buckle sideband surface the rules-fired list.
   Raw rules for politeness tier: drop/prefix/dedupe/meta classes.
6. **L6 Byte-stability**: same input + same `CONDENSE_VERSION` ⇒ same
   output, no clock/seed/locale/I-O. Version bumps require a snapshot
   diff review in the bench report.

## Eval plan (blam-bench fidelity family)

- **Engine self-checks** (CI-cheap, LLM-optional): L1 protect-surface
  survival (tokenized extraction before/after), L2 hedge survival,
  L3 invariant survival, L4 idempotence, L6 snapshot pins per version.
  These are blam unit tests, not a scenario.
- **blam-bench fidelity scenario** (`bench/scenarios/condense-fidelity/`):
  sealed prose corpora → transform → deterministic checkers score
  meaning-preservation failures (protected-token loss, hedge loss,
  instruction-verb loss) + shrink ratio. Per-tier reports.
- **Arena integration**: belt arena `--condenser` already pluggable —
  points at blam tiers; W368's per-model bench rides it unchanged.
  `ref-condense/1` retires; its numbers keep their run-ids.

## Migration order (each step lands independently)

1. **blam engine** — `src/condense/{engine,tiers,version}.ts` + self-check
   tests + snapshot pins. No consumer touched. Snapshot of tier outputs
   pinned from the CURRENT suspenders implementation bytes (parity pin).
2. **suspenders swap** — board `prompt-transform.ts` + `dispatch-next.ts`
   import the blam engine (tier `politeness`+`caveman` unchanged
   semantics); snapshot parity proves byte-equal on a corpus built from
   real briefs; the inline FILLER/PROTECT/META_RE/dedupe code is deleted.
3. **buckle swap (W304.3)** — `pipeline.ts condenseText` delegates to the
   blam engine (tier `politeness`), keeping the `CondenseResult` audit
   shape; W304.3's router wiring consumes the same engine. W304.2 belt
   router wiring consumes it too.
4. **belt arena retirement** — `ref-condense/1` deleted; arena's default
   condense Transform points at blam tier `aggressive`; W368 benches all
   three tiers per model.
5. **Docs** — this spec + blam README gain the one-paragraph pointer; the
   `finding.condense-ruleset-divergence` fact records the inventory.

## Consequences

- One ruleset, three consumers, eval co-located with engine. New tiers are
  data rows + bench rows, not new implementations.
- blam gains a `src/` with a pure module — no runtime deps, doctrine
  intact ("LLM-optional, deterministic, CI-runnable").
- The W287 hedge law becomes EXECUTABLE (test-enforced) instead of
  comment-enforced — the belt outlier cannot regress silently.
- Consumer diffs stay small and revertible; the engine lands first with
  parity pins, so the migration is bisectable.
