# AGENTS.md — supervisor contract + package law

The fleet-wide lane protocol (plan-first, shatter judgment, gates, done,
inbox/narration) is single-sourced in the repo-root AGENTS.md § Lane
protocol — package files point there, they do not restate it. This file
carries the supervisor reporting contract and suspenders package law.

## Supervisor reporting (W892 standard, owner GO 2026-10-19)

Every supervisor/user-centric tick replies with the ONE standard table:

    work report

Emit its output verbatim in a fenced block, headed by one status line
(lanes live x/N, READY n, dispatched). Columns: ITEM/ST/TASK/TOKENS/
CACHE/OUT-MIN/AGENT/MODEL/EFFORT/CONSULT — CACHE is prompt-cache hit share (cached ÷ (fresh+
cached)), OUT/MIN is output tokens per agent-minute, AGENT is agent wall
time, MODEL is the top model_group by attributed tokens (`+` when several),
EFFORT the lane's effort level (dispatch pins SUSPENDERS_LANE_EFFORT into
the per-lane 0600 settings; `work done` banks it into the work.done event),
CONSULT Y/N = the item's lane banked knowledge (knowledge-enqueue) or
consulted (the event payloads carry the item link, W909). A CACHE cell
suffixed `*` = the item's attributed spend includes cache-blind-era ledger
rows (pre-2026-10-19T10Z `router_usage` carries cache≈0 — W943.1): read
that number as a floor, never a measurement
(docs/decant-crosscheck-2026-10-19.md). ST: R riding · Q queued · D done · F failed. Item ids double as
`#lanes?w=<id>` deep-links (W890). Do not hand-roll the table — the
reporter computes the pads; prose tick lines are a regression.
(The installed face `bun ~/.claude/hooks/suspenders/bin/fleet-report.ts` is a verbatim shim over the verb — W913.)

## Protocol

Point at the root: the fleet-wide lane protocol lives in the repo-root
AGENTS.md § Lane protocol (single source). Suspenders adds nothing to it.

## Consult/Broadcast Narration

Point at the root: fleet-wide inbox/narration doctrine lives in the
repo-root AGENTS.md § Lane protocol (single source).

---

## Package law

Agent control plane: governor.db (SQLite/WAL) work graph, coord bus, fleet
board (:7799), launchd agents, hook gates. Docs: docs/, board API at
http://suspenders.local/llms.txt. Companions: belt (LLM fleet), klh/local
(Caddy .local services), speedy (config layer).

## qlty Quality Doctrine

The fleet-wide law (root AGENTS.md § Laws) applies; the on-write gate lives
HERE (hooks/gates/files.ts): on-write — qlty-fmt + fast lint, formatting
advisory, unresolved issues block; worktree lanes defer cosmetic formatting
until completion. Pre-merge — fmt + check + tests before commit; on-stop —
deferred formatting and quality reverification. Recurring offenders to
never emit: non-null `!` (noNonNullAssertion), string `+ "\n"` concat
(useTemplate), comma operator, unused vars/imports, use-before-declaration.

**Quality timing (W869, owner GO 2026-10-19):** useLiteralKeys and
noNonNullAssertion are WRITE-TIME blocking — `promotedClassViolation` in
hooks/gates/files.ts refuses the payload even without qlty on PATH. A claimed
lane's edit outside its registered dispatch worktree (`.worktrees/<item>`)
denies PRE-write (`locationVsClaim` in hooks/gates/governor.ts) — lanes never
dirty the shared checkout. The merge ladder auto-fixes whatever still lands
(`qltyFixMergedFiles` in hooks/lib/fleet-loop/merge.ts: `qlty check --fix` +
the cached biome binary, committed on main).

## 1500-Line Hard Limit

The fleet-wide law (root AGENTS.md § Laws) applies; here it is enforced by
the on-write gate (hooks/gates/files.ts, W157) — fleet-board, coord,
board-html and the fleet-board suite all live under the limit.

**Patch-first near-cap contract (W744)**: a .ts above ~1200 lines is near-cap —
dispatch briefs for file maps that surface one carry a patch-only directive
(hooks/lib/patch-first.ts), and `work done` verifies the diff shape: churn
beyond 300 added+removed lines on that file refuses closure unless the item IS
a decomposition (title/description declares it). `SUSPENDERS_PATCH_FIRST=0`
disables the done-gate check; the benchmark is `bun scripts/edit-precision.ts`.

Integration supervisors also apply a **soft post-merge cap**: changed code files
above 1500 physical lines create a deduplicated `DRY and decompose <path>` work
item and a `code.decomposition-needed` event with merged blob evidence. This
checks the combined committed file, including work merged by other lanes, and
does not reject a successful merge. Decomposition must remove repeated patterns,
split by responsibility into a purpose-named subdirectory or well-named sibling
files, and import those modules from the original entrypoint. Generated/vendor
files are excluded. The existing on-write hard gate remains separate.

## UI Engineering Law

The fleet-wide law (root AGENTS.md § Laws) applies; package specifics:
migrations of legacy chunks get REWRITTEN to lit-html templates (never
ported as strings) per the W184 staged migration — elimination, not
deprecation. Components own their DOM (shadow DOM, reactive properties,
CustomEvents); tokens own the styling (surface/ink/spacing/type + plane
hues). Follow the `lit-dev` + `frontend-ui-engineering` skills
(`~/.claude/skills-available/`).

## CLI Toolkit Law (W651)

`hooks/lib/verb-kit.ts` is the ONE way new CLIs declare, parse, and explain
verbs: `defineVerb({...})` into a registry; the kit owns argv parsing (the
Bun strips-`--` reality baked in), per-verb `--help`, generated help and
unknown-command try-lists, and the uniform `prog: message` die. The big
three ride it (work.ts process door, coord.ts run wrappers, registry-cli.ts
pure door). **New CLIs MUST use the kit — no hand-rolled `process.argv`
dissection, no hand-maintained usage blocks.**

## Streams Over Buffers

The fleet-wide law (root AGENTS.md § Laws) applies; package specifics:
streams for HTTP/SSE pass-through, NDJSON/line streams for logs and feeds,
bounded rings with backpressure for async writes (the W143 ledger ring is
the pattern). Buffers only for bounded, size-capped payloads.
