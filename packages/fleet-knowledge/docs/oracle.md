# Oracle

Oracle is the named review/escalation tool: one stateless surface with a
fixed prompt contract — review this diff / find bugs / analyze this —
replacing ad-hoc "review this" phrasing in agent prompts. The default leg
is PINNED to a local-reasoning tier (a direct OpenAI-wire POST — never
router-classified, never role-dispatched); `--cloud` fires the stronger
cloud route through the gateway's own escalation leg. NO automatic
stuck-detection routing: the tool never fires on its own — an agent or
human invokes it, explicitly, every time.

## Usage

    oracle review  [--in FILE | --repo DIR [--base REF]] [--cloud] [--max-tokens N]
    oracle bugs    [--in FILE | --repo DIR [--base REF]] [--cloud] [--max-tokens N]
    oracle analyze [--in FILE] [--cloud] [--max-tokens N] [topic words...]
    oracle panel   [--cloud] [--max-tokens N]

Input: `--in FILE`, else piped stdin, else (review/bugs) the working-tree
diff of `--repo DIR` (default cwd; staged + unstaged; `--base REF` diffs
vs REF). stdout = the answer; stderr = one route line — parents parse
stdout.

## The fixed prompt contract

Each verb rides a FIXED frame — never free-form. The final lines are
machine-parseable, so callers can gate on them:

- **review** (`REVIEW_FRAME`): findings as terse bullets, each with a
  stable ID — `B<round>-<slug>` (blocker) or `N<round>-<slug>` (note),
  round = the round that FIRST reported it, IDs are never renumbered.
  Evidence-kind caps severity: a file:line-only claim caps at
  blocker(high); a runtime-behavior claim without a trigger path caps at
  note(low). When PRIOR FINDINGS are listed, the reviewer must
  acknowledge EVERY one by ID before any new finding, with exactly one
  status — `<ID>: fixed | still-open | not-verifiable — what was re-run`.
  Only an explicit "fixed" closes a finding; a prior blocker left open
  forces the verdict.
- **bugs**: one terse line per bug — file:line — bug — severity. Style
  nits are not bugs. Ends `BUGS: none | BUGS: <n> found`.
- **analyze**: structured and terse — WHAT: one line · HOW: bullets ·
  RISKS: bullets · OPEN QUESTIONS: bullets.
- **panel**: a consensus row set from multiple legs (`consensusOf`).

`REVIEW_FRAME` lives in one module (`src/oracle-frame.ts`) so every
consumer — including benchmark pins — imports the same string instead of
a drifted copy. Pure text, no side effects.

## Legs

Two legs, ONE gated LLM boundary:

- **Pinned leg (default).** The local-reasoning tier through the gated
  boundary — `model` defaults to the built-in pin `"local-reason"`,
  overridable via `ORACLE_ROUTE_MODEL`.
- **Cloud leg (`--cloud`).** The stronger cloud route; its model is a code
  constant (the escalation pin). Both legs resolve the same gate conf
  (`SUSPENDERS_BUCKLE_URL` + `SUSPENDERS_BUCKLE_TOKEN`, or the 0600
  knowledge-buckle.json file) — there are no separate oracle endpoint
  knobs, and the pinned leg is never router-classified.

Both legs ride the ONE gated LLM boundary (inference-buckle): explicit
budget admission, trace propagation so failures join the gateway's route
audit by trace id. The oracle never opens a second, unaudited path.

## Exit codes

    0  answer delivered
    1  usage or input error
    2  leg failure (both legs failed, or the pinned leg failed with no cloud)

## Honest-uncertainty rules

- Style nits are not bugs.
- Evidence-kind caps severity (see above).
- A reviewer that cannot re-run prior findings marks them
  `not-verifiable` rather than guessing.
- The `VERDICT: PASS | VERDICT: FAIL - <reason>` final line is the
  machine contract: parents parse it, and only it.

## Config

See `.env.example` (oracle section) for the route knobs. The oracle is a
CLI: `make oracle ARGS="review --cloud"` or
`bun run bin/oracle.ts <verb>`.
