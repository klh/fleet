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
- **MCP servers as long-lived data planes** — repeated CONNECTION_CLOSED on
  live sessions (dinero); a dead MCP = silent capability loss. CLIs +
  one-shot Bun scripts are the durable surface; MCP only where a protocol
  surface is genuinely needed.

## Context / token economy

- **Banking telemetry-shaped knowledge as facts rows** — W949's blind A/B
  (2026-10-19, 10 real-fleet questions, identity-blind judge, 2 stable runs):
  the banked layer answered 0/5 telemetry questions (per-item fact rows carry
  work-prose, not numbers) while decant answered 5/5 at zero banking cost —
  telemetry retrieval is mechanical-first, numbers never get banked. Judgment
  lessons stay banked as a ~17× cheaper-to-read distilled cache (640 B vs
  11 KB per hit), but decant covered the unbanked rest (J1/J4/J5 full marks).
  Banking amortized spend ≈ 1.25 Mtok (1.6% coord-knowledge share of 78.1 Mtok
  CONSULT=Y spend). Caveat: decant subsumes banked content (lanes echo facts
  into transcripts); see the
  [bench record](packages/suspenders/bench/w949/README.md) +
  [benchmarks.md](benchmarks.md#knowledge-retrieval--llm-banked-facts-vs-mechanical-decant-w949-2026-10-19).
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
