# W943 — decant cross-check: independent transcript analytics vs W776 attribution

Date: 2026-10-19 · lane `autow943-p98b319584008df14` · item W943 · verdict
**TRUST** (current-era fronted lanes) with **CORRECTION-NEEDED** residuals
(era gap + named non-lane pools) — curated row in
[benchmarks.md](../benchmarks.md) (Fleet attribution validity section).

## Question

Do the fleet report's TOKENS / CACHE / OUT-MIN columns (W776 attribution:
buckle-ledger `router_usage` ⋈ work-graph claim windows) measure what the
transcripts themselves record? Independent recount: decant
(dosu-ai/decant, Apache-2.0, local-first) parsing the same
`~/.claude/projects/*.jsonl` transcripts.

## Method

- `bun packages/suspenders/scripts/decant-crosscheck.ts --by-sid` (committed;
  read-only on all three stores). Window: 7 days (2026-10-12T13:00Z → run
  time), project scope = fleet root + `.worktrees/*`.
- Session→item join: the item id parsed from the session's worktree path
  (`.worktrees/W927` → W927); sid = that item's claim windows, restricted to
  sids present in the ledger. A pure max-overlap window join is UNSAFE:
  stale open windows (a lane riding for 23h+) tie-steal other lanes'
  sessions and smear attribution.
- Subagent subtrees roll up into their top-level session before any
  comparison (the gateway saw one key; the transcripts split the work).
- Gateway hour buckets attribute to the maximally-overlapping session of
  the same sid; leftover buckets = the unmatched pool.
- decant validation: one closed session recounted from raw jsonl with
  one-row-per-unique-message-id dedup matches decant's session row
  EXACTLY (201,337 in / 21,786 out / 3,970,816 cache-read). Raw-line
  summation double-counts ~2x — transcript usage rows repeat per message id
  (streamed re-emissions); dedup by `message.id` is mandatory.

## Result — matched (fronted) lanes agree within ±1–3%

Per-lane (sid), 7d, fresh/cached/output tokens:

| sid (item)                      | W776 f/c/o                    | decant f/c/o                  | Δtot |
| ------------------------------- | ----------------------------- | ----------------------------- | ---- |
| autow934-2-1-2 (W934.2.1.2)     | 536k / 38.02M / 176k          | 551k / 37.69M / 159k          | −1%  |
| autow914 (W914)                 | 403k / 37.98M / 134k          | 419k / 37.81M / 123k          | 0%   |
| autow927 (W927)                 | 367k / 34.95M / 181k          | 383k / 34.78M / 172k          | 0%   |
| autow911 (W911)                 | 388k / 33.01M / 146k          | 403k / 32.73M / 132k          | −1%  |
| autow858-10-3 (W858.10.3)       | 289k / 32.83M / 127k          | 305k / 32.67M / 117k          | 0%   |
| autow932 (W932)                 | 257k / 30.57M / 117k          | 272k / 30.40M / 111k          | −1%  |
| autow925 (W925)                 | 341k / 18.19M / 168k          | 356k / 18.05M / 159k          | −1%  |
| autow870 (W870)                 | 176k / 18.35M / 70k           | 193k / 18.35M / 70k           | 0%   |
| autow682 (4 sessions)           | 334k / 17.49M / 44k           | 404k / 17.49M / 44k           | 0%   |
| autow859-1                      | 518k / 11.94M / 64k           | 535k / 12.71M / 64k           | +6%  |
| autow889                        | 186k / 10.56M / 41k           | 204k / 10.89M / 41k           | +3%  |
| autow947 (LIVE at run)          | 110k / 10.49M / 49k           | 118k / 8.41M / 45k            | −19% |
| autow948 (LIVE at run)          | 150k / 10.01M / 50k           | 158k / 7.89M / 45k            | −21% |
| autow943 (this lane, LIVE)      | 151k / 9.71M / 54k            | 160k / 8.22M / 49k            | −15% |

Closed-lane agreement: |Δ| ≤ 3% on every sampled fronted lane (267 sid rows
in the full run). LIVE lanes read negative (−15..−21%) because a riding
session's transcript flushes behind the ledger — an artifact of comparing a
live lane, not drift.

Fleet totals (7d, in-scope): W776 42.19M fresh / 975.27M cached / 12.32M
out; decant 47.98M / 2,464.99M / 11.91M ($82.81 decant-estimated cost). The
cached-total gap is the era gap below (pre-Oct-19 lanes), not matched-lane
drift.

## Top drift causes

1. **Cache-invisibility era (pre-Oct-19).** `router_usage` carried ~0 cache
   for essentially all lane traffic Oct 12–18 (glm-group daily cache sums:
   0.77k–1.0M tokens/day on 0.8–9.7k requests) and jumped to 858.8M on Oct
   19. Transcripts from those days show 90–99% cache share per session. So
   the W776 CACHE column undercounts by ~90+ points for anything claimed
   before the fix; today's fronted lanes match transcripts ±1–3%.
2. **Non-lane infrastructure traffic in the same ledger.** `prefix-keepwarm`
   (4,398 req, 1.12M fresh + 2.34M cached) and `watchdog-probe` (3,030 req,
   0.66M) hold ledger rows with no claim window — correctly excluded by
   attribution, but the raw ledger is not lane-only; the window join is
   doing real work. Residual unmatched pool: 2.47M fresh / 2.09M cached /
   147k out over 7,289 requests.
3. **Per-lane constant fresh offset (+15–16k).** Every matched lane shows a
   constant transcript-fresh surplus over the ledger (bootstrap-sized; ~0.05%
   at fleet scale) — consistent with the first request(s) of a lane riding
   belt-direct before the per-lane key is pinned. LIVE-lane flush lag
   (cause above) and W820.1 (NAS-flip lane: 20.61M transcript cache vs 0
   ledger — a still-cache-blind leg) are the named per-lane residuals.

## decant itself

- Parse validity: verified exact against a raw unique-id recount (above).
- Operational gotchas (matters if this reruns): the full-corpus sync crawls
  the projects dir alphabetically and a first pass ended (exit 0) having
  reached only `...worktrees-W576` — recent worktree dirs need a targeted
  `decant sync --path <dir>` (repeatable) to be certain. The index DB
  (~/.decant/decant.db) is UNENCRYPTED and holds full transcript content —
  analysis stays aggregate; never commit from it.
