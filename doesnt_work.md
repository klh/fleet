# doesnt_work.md — the negative-results ledger

Optimizations we actually tried that did not deliver, with the failure
mechanism and the standing rule that replaced them. Complements
[benchmarks.md](benchmarks.md) (the winners). Every row must be
decision-grade: it has to change what you would do. When a verdict flips
(new numbers), move the row to benchmarks.md with the date.

## LLM serving

- **Speculative decoding, 4B draft → big target (MLX)** — verified no win at
  4B scale; the verdict does not extrapolate to 30B+ (see W242: re-bench when
  an MTP-capable 30B+ resident model exists). Replaced by: don't burn lanes
  on sub-30B speculation.
- **rapid-mlx 0.15 upgrade, bought for speed** — benched 115.9 vs 107.4
  tok/s under load, flat on a quiet machine. Adopted for flags/aliases
  ergonomics, NOT speed; the speed claim died.
- **mlx_lm KV/prompt-cache flags (W240)** — `--prompt-cache-size` /
  `--prompt-cache-bytes` are a NO-OP on mlx_lm 0.31.3. `serverKvArgs` probes
  for flag support and currently emits nothing. Revisit when upstream ships
  cache-file ingestion.
- **GitHub Copilot seat as a lane carrier (W695.6)** — quota-walled within a
  day; `retry-after` floors were weeks-long. Verdict: proxy/overflow tier
  only, never a primary carrier.
- **litellm as the Copilot bridge** — its `/v1/messages` bridge hits the
  Responses API that Copilot rejects, and its provider forces an interactive
  device flow. The :4102 ikea-shim is retired, litellm copilot rows stay off;
  the raw api.githubcopilot.com Anthropic wire works instead.

## Fleet coordination

- **Priority-derived lane effort (W923 pin, retired by W1140)** — the
  dispatch effort pin read `item.priority` off a string item id, so every
  lane pinned "medium" regardless of graph state (dead code), and priority
  alone is the wrong signal anyway — effort does not rescue wrong approaches
  (SlopCodeBench wrong-reading failures rose 25→47 at max). Replaced by:
  classification-driven pin from the machine-conf lane-effort policy
  (verification-shaped → high, research → medium, unmatched → two-stage
  implement low / verify high).
- **Unbounded supervisor consult (W977.2)** — re-asking the coordination
  ledger per step (3 asks/item, retry budget 4) returned identical
  outcomes to 1 ask/item at 2.3× the consult volume (21 vs 9 calls,
  2,520 vs 1,080 tok). Replaced by: bounded consult — one combined
  claims+capacity ask per item decision, retry budget 2; the
  transactional claims ledger remains the correctness backstop.
- **Independent supervisors skipping the claims ledger (W977.2)** —
  never-consult/never-claim regimes completed every shared scope twice
  (3 dup units per run) and oversubscribed the shared lane budget by
  30 lane-min on pressure. Replaced by: consult-then-claim with clean
  yields on foreign claims; consult is the capacity defense, the
  transactional ledger is the correctness backstop.

- **Parallel burst lane spawn** — cold-start contention killed lanes
  (2026-10-15 mass lane death). Serial cadence + fenced registration
  (identity = owner + live state, no `updated_at` re-check) is the fix that
  held; bursts are banned.
- **Paired-lane dispatch (2 lanes per worktree)** — locks picked the writer,
  but dead lanes kept holding the target. Replaced 2026-10-06 by
  process-backed liveness (session vote AND worktreeLive + grace).
- **Markdown ledgers for coordination** — drifts and is invisible to other
  lanes. One ledger: the work graph CLI; Markdown = architecture/decisions.
- **Re-mint + supersede for FAILED items** — ledger-polluting, produced
  corrupt rows (W751.3/W752 `result_sha="--note"`). Replaced by `work retry`
  (44092cbb): FAILED→READY, budget reset, one transaction.
- **Hub knowledge reads on doc-covered ground** — +45% tokens in the W94
  A/B (paid the hub AND the files). Skip-the-read taxonomy; the hub is for
  cross-repo/incident knowledge only.
- **Auto-routing stuck lanes into oracle review** — rejected at W647: stuck
  detection is a false-positive machine. Oracle is explicit invocation,
  every time.
- **In-process mock hub for spawned-CLI federation tests (W934.2.2)** — a
  spawned coord CLI cannot reach a `Bun.serve` mock on 127.0.0.1 on this
  macOS 26 build, so the live consult bench's hub arm cannot ride an
  in-process server (W934.2.1.2 solved it with in-process fixture DBs
  instead). The bench defers the hub arm until a real hub endpoint is
  reachable; the expert/kb arms run against the scratch plane.
- **MCP servers as long-lived data planes** — repeated CONNECTION_CLOSED on
  live sessions (dinero); a dead MCP = silent capability loss. CLIs +
  one-shot Bun scripts are the durable surface; MCP only where a protocol
  surface is genuinely needed.

## Context / token economy

- **Advisory-only effort budgets as a spend target (W1140.1)** — the W1140
  policy surfaces budget baselines in the lane brief (low 100k / medium 200k /
  high 300k tokens) but nothing in the ride observes them: post-policy low
  lanes average 4.5M fresh tokens (45x baseline, W776 ledger, n=14), and not
  one lane in either cohort finished within budget (1/60 pre, 0/18 post).
  Mechanism: baselines are prose in the brief, never checked at checkpoints;
  per-item attribution also bills whole multi-day rides, inflating the
  comparison. Replaced by: treat budgets as unmet until a ride-time budget
  signal exists (checkpoint when a lane crosses its baseline, surfaced on the
  board) or budget semantics are redefined to per-agent-hour.

- **W960 self-improvement on the pinned local GLM/Claude route** — the
  2026-10-20 AC smoke generated a candidate but both arms failed all three
  private judges: the executor made empty patches, and Claude reported zero
  usage tokens. A direct run reproduced a denied Write with the normal config;
  a clean config removed that denial but still produced no file. Do not run the
  130-case promotion suite or treat zero usage as free inference. First prove
  one real file edit and positive usage on the exact executor route, then rerun
  the smoke. See the [W960 receipt](benchmarks.md#w960-harness-self-improvement-smoke-2026-10-20-ac).
- **W960.2 generated starter from one probe** — with a working Codex executor,
  the current starter passed 3/3 private judges while the candidate passed 2/3,
  used 18% more reported tokens, and wrote a probe-specific file in a held-out
  task. The three-task smoke proves this candidate should not be promoted; it
  does not estimate general quality. Keep the private held-out gate, and reject
  task-specific probe content before spending on a 130-case run. See the
  [paired receipt](benchmarks.md#independent-codex-executor-smoke-w9602-ac-three-paired-tasks).
- **Compact module map and automatic second reviewer on a small known repair**
  — W922's held-out Relay pilot (2026-10-19, one task × 3 paired repetitions,
  `gpt-6-luna`) reached 22/22 with the plain solo agent. The extra map used
  375.9k vs 260.7k reported tokens per arm (+44%); a fresh reviewer used
  937.4k vs 269.0k (+248%), with no oracle-score improvement. Do not enable
  either treatment by default for this task class. This is a smoke result,
  not evidence against context injection or review on harder work; see the
  [paired receipts](benchmarks.md#relay-coding-pilot-w922-2026-10-19-ac-one-held-out-task--3-pairs).
- **Shattering three small pure functions into separate agent calls** — W922's
  corrected Relay pilot (same model and one task × 3 pairs) shortened mean wall
  time from 25.3 to 18.2 seconds, but raised reported tokens from 260.0k to
  652.1k and one split arm scored only 13/22 while all matched solo arms got
  22/22. Do not split this class by default; use parallel agents when the
  tasks are large enough to pay for three separate contexts and integration.
  The first run was invalid because BLAM trimmed `git diff` patches; the
  patch-capture regression test now guards that harness failure.
- **Cold-context lane orientation** — measured 2026-10-15 (n=3, live route):
  cold median 76.6s / 49,752 fresh tok vs forked-starter 15.8s / 1,659 fresh
  tok / 97% cache share. Starter forks now default-on for the claude
  executor (W768); this row is why.
- **Whole-file Write emissions for large files** — semantically corrupted
  emissions passed the parse gate (ghost identifiers, garbled constants).
  Rule: ≤35-line chunked/anchored edits, parse-check + generated-diff review
  before apply; whole-file ports go through `git show` extraction.
- **Banking telemetry-shaped knowledge as facts rows** — W949's A/B
  measured the banked-facts layer losing preference 0/5 to a mechanical
  transcript sweep, and W956's round 2 re-ran it on a W952-protocol
  FROZEN corpus (snapshot sealed before question selection, bench-lane
  eras excluded — zero self-echo possible): sweep confirmed, 8 picks to
  0 with 2 ties, judge-scored telemetry 5/5 with the one residual gap
  (T3 cache-rate; T1's GT accepts either view) being exactly the
  ledger-only metric mechanical cannot serve, and the facts layer's
  only full answers remain the two banked lessons (J2/J3, ties at 5/5)
  at ~17× cheaper per-hit reads. Round 2's
  confidence-stamp twist (W953/W955 schema on both arms) moved nothing
  measurable — zero banked rows carry a rating, so band-filterable
  discovery is theoretical until the corpus is backfilled. Standing
  policy: mechanical-first (decant) with fact-backfill only for
  ledger-only metrics; bank judgment lessons, never telemetry numbers.
  [Round-2 receipts](benchmarks.md#knowledge-retrieval--stamped-mechanical-vs-stamped-factskb-frozen-corpus-w956-round-2-2026-10-19).

## Tooling

- **Shell scripts as the automation surface** — escape-hatch sprawl, no
  types, no tests. Banned repo-wide; TypeScript on Bun only (pinned legacy
  .sh set is the guarded exception).
- **`qlty fmt --all`** — reformats untouched files (biome drift pollutes
  PRs). Always pass the changed paths.
- **`Bun.write` with `{append:true}`** — truncates/rewrites the file on
  Bun 1.4.2. Appends go through `node:fs` appendFile.
- **`rg -rn`** — `-r` is `--replace`; the "n" is a replacement string.
  Plain `-n` for line numbers, every time.

## Rejected before trying (kept so we don't re-litigate)

- **Iroh/DHT registry for fleet knowledge sync** (qvac2 lift-review) —
  overkill vs coord facts + governor.db as the single coordination plane.
- **Composite FK-less rekey without `PRAGMA defer_foreign_keys`** — W428:
  rekeying work-graph identity hits composite FKs 500 without it;
  children-first in one transaction.

## W1170 — regex fixture coverage is not a review-quality evaluation

W1144 treated matching trap names in skill text and the seeded examples in
`tests/fixtures/review-eval/seed.ts` as evidence of better agent reviews.
`tests/skills-catalog.test.ts` only checks text markers: no reviewer ran,
no matched comparison was performed, and no quality improvement was proved.
W1170 retains the documentation contract while correcting its description.
Skill invocation counts also require no raw arguments or working-directory
paths; storing those in a mode-644 log added disclosure risk without
measurement value. The corrected logger keeps minimal metadata at mode 0600.
