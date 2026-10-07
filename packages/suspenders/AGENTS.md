# AGENTS.md — lane working protocol

How to work in this repo as a dispatched lane — written for any agent CLI
(`claude -p`, `codex exec`, or a human). The dispatch brief carries WHO you
are and WHAT the mission is; this file carries HOW. Read it before any edit.

## Protocol

0. **PLAN FIRST** — before any edit: `eza -T` the directories the mission
   touches (or `git ls-files`) for the shape, then rg the areas it names,
   read the files you would edit and `.qlty/qlty.toml` + the biome rule set.
   Code to the spec — never emit flagged patterns for the gate to catch.
   Note what live lanes already own: the governor denies parallel edits to
   a leased file; re-read and retry, it integrates rather than blocks.
1. **SHATTER JUDGMENT** — if the mission decomposes into 2+ genuinely
   independent scopes, do NOT implement it all here:
   `bun ~/.claude/hooks/suspenders/bin/work.ts split <id> "child one title"
"child two title" --reason independent-scopes --keep 1`, work only the
   kept child, end with `SPLIT <id>` — the fleet refills the rest. A split
   beyond 2 children needs a registered plan item first (`work add "plan: …"`,
   then `split --plan <id>`). Your inbox is WS-first (W303): `coord subscribe
   --as <sid>` attaches at spawn/bootstrap, idempotent per sid — one
   persistent push connection whose feed tails
   `~/.claude-insights/coord-subscribe-<sid>.log`; never poll it. `coord
   inbox --as <sid>` is the catch-up read before starting and before
   finishing — coordinator/board messages arrive there (drawer "send
   message" delivers there).
2. Work in the worktree + branch your brief names. SMALL anchored edits;
   co-situated tests for new logic; never hand-edit files another live lane
   owns.
3. **GATES** — `qlty fmt` + `qlty check` on changed files → "No issues";
   `bun test` on the files you touched → green.
   Match adjacent code and the nearest Biome configuration while writing.
   Let `qlty fmt` handle canonical whitespace and wrapping before final
   checks, tests and commit. Successful auto-formatting is advisory; read
   the updated file only before editing it again. Worktree lanes defer
   cosmetic formatting until completion; lint and size failures still block.
4. Commit on your branch (subject = the item title), push the branch. NO tags.
5. Finish: `bun ~/.claude/hooks/suspenders/bin/work.ts done <id> --sha <branch-head>`.

Final line of output: `DONE <sha>` | `SPLIT <id>` | `BLOCKED` (after 3
honest attempts, tree restored).

## Consult/Broadcast Narration

Any CLI watching `coord inbox`/`coord subscribe` narrates terse, not
verbose — as your own plain response text, never as a shell `echo`/tool
call (that's a visible tool-invocation block in the transcript, not
narration). The templates below are the ENTIRE narration — no parenthetical
asides, no explanations, no extra sentence tacked on. `coord subscribe` is
one persistent WebSocket (W303, store-server.ts `/subscribe`) — it never
exits and needs no relaunching; prefer it over `coord wait`'s poll/relaunch
loop. If it ever does reconnect (transient drop), that's pure mechanics:
zero narration, ever.

- Not addressed to you and not a consult (routine BROADCAST, work.landed,
  knowledge.settled, etc.) — say nothing, just advance past it.
- A consult addressed to your sid:
  ```
  consult: [C12] 3bb4718c asks <question, truncated>
  thinking
  consult: [C12] replying <answer, truncated>
  ```
- A fleet-wide consult (`--best`, no single addressee):
  ```
  consult: fleet asks, <question, truncated>
  thinking
  consult: fleet, no knowledge, didn't reply
  ```
  or, if you have an answer:
  ```
  consult: fleet, details forwarded
  ```

Repo doctrine (quality bar, architecture) lives in Package law below.

---

## Package law

Agent control plane: governor.db (SQLite/WAL) work graph, coord bus, fleet
board (:7799), launchd agents, hook gates. Docs: docs/, board API at
http://suspenders.local/llms.txt. Companions: belt (LLM fleet), klh/local
(Caddy .local services), speedy (config layer).

## qlty Quality Doctrine

qlty is THE quality tool; `.qlty/` must exist or the governor's on-write
gate silently no-ops. Three moments: (1) on-write — the post-files gate
(hooks/gates/files.ts — they live in THIS repo) runs qlty-fmt + fast lint;
successful formatting is advisory, unresolved issues block. Worktree lanes
defer formatting and cosmetic checks until completion; lint still runs on
each write. (2) pre-merge — `qlty fmt` + `qlty check` on changed files,
then tests before commit; (3) on-stop — deferred formatting and quality
reverification. A successful formatter rewrite does not require another turn.

**SPEC FIRST: read `.qlty/qlty.toml` and the biome rule set BEFORE the first
write here, then code to the spec.** Never emit flagged patterns and let the
gate catch them — recurring offenders: non-null `!` (noNonNullAssertion),
string `+ "\n"` concat (useTemplate), comma operator, unused vars/imports,
use-before-declaration. biome owns code formatting; prettier owns markdown
only — never enable both on code (they deadlock).

## 1500-Line Hard Limit

Any .ts (or equivalent) that grows past **1500 lines MUST be decomposed**:
split by responsibility, DRY the second duplicate, and run a codescan for
shareable patterns (ast-grep) before adding code near the limit — one
source of truth per pattern, helpers over copy-paste. Applies to every lane
and every klh repo. The on-write gate **blocks** any .ts past 1500 lines
(W157 2026-10-01: law enforced in hooks/gates/files.ts — the W157 backlog is
cleared; fleet-board, coord, board-html and the fleet-board suite all live
under the limit).

Integration supervisors also apply a **soft post-merge cap**: changed code files
above 1500 physical lines create a deduplicated `DRY and decompose <path>` work
item and a `code.decomposition-needed` event with merged blob evidence. This
checks the combined committed file, including work merged by other lanes, and
does not reject a successful merge. Decomposition must remove repeated patterns,
split by responsibility into a purpose-named subdirectory or well-named sibling
files, and import those modules from the original entrypoint. Generated/vendor
files are excluded. The existing on-write hard gate remains separate.

## UI Engineering Law

Console/board UI is **Lit web components + CSS design tokens**.
**NEVER `innerHTML`, never `document.write`** — anywhere, ever, including
migrations of legacy chunks (they get REWRITTEN to lit-html templates, not
ported). Follow the `lit-dev` + `frontend-ui-engineering` skills
(`~/.claude/skills-available/`): domain compositions (topbar, work-card,
usage…), **native elements and integration first** (`<select>`, `<dialog>`,
`<details>` before custom), inheritance via composition. Components own
their DOM (shadow DOM, reactive properties, CustomEvents); tokens own the
styling (surface/ink/spacing/type + plane hues). Lit is vendored (offline
LAN — never CDN). Legacy string chunks retire per the W184 staged
migration — elimination, not deprecation.

## Streams Over Buffers

Streaming interfaces by default — no whole-payload buffering or memory
hangups unless strictly necessary: streams for HTTP/SSE pass-through,
NDJSON/line streams for logs and feeds, bounded rings with backpressure
for async writes (the W143 ledger ring is the pattern). Buffers only for
bounded, size-capped payloads. Fleet law (`law.streams-over-buffers`).
