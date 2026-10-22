# fleet — the klh agent stack

One monorepo, one version, every service. packages/: suspenders (control
plane), buckle (LLM gateway), belt (dashboard/gateway), speedy (config
layer), local (Caddy front), local-llm (MLX swarm kit), blam (agent-mishap
benchmark). The private enterprise tier = klh-remote (mirrors packages/,
depends on fleet; local-only until its GitHub push — W422.9/W422.1).

## Laws (project-wide, every package)

- **One version**: `version:` in `~/.config/klh/stack.yaml` pins buckle +
  suspenders + belt; hubctl renders it as the git ref every hub pulls.
- **Config-over-code**: real hosts, keys, OIDC values live ONLY in
  machine-level runtime config (`~/.config/klh/stack.yaml`,
  `~/.claude/local-llm/*.env`, mode 600) — repos carry placeholders only.
- **Health is outside-process** (owner law 2026-10-05): a server cannot
  paint itself healthy. Every hub service gets a `*-health` probe sidecar
  (deploy/healthcheck/probe.ts) that polls the real target over the
  network, serves the verdict on its own port, degrades on consecutive
  misses, and actively re-probes before flipping to down; compose health
  hits the SIDECAR, never the served process.
- **Secrets are minted, never typed**: root keys generated ON the target
  device (0600, idempotent, never printed); admin + per-lane `bksk_` keys
  minted via the gate's admin API; revocable, audited.
- **Scrub gate (W236)**: git commit/push runs staged/unpushed ADDED lines
  through the scrub rule set (hooks/lib/scrub.ts): `/Users/<user>` paths,
  local-denylist hosts/IPs/MACs (`~/.claude/local-llm/scrub-denylist`, mode
  600, machine-local, never committed), key material (sk-/AKIA/ghp_/PEM/
  slack), IKEA-internal markers. Denies with file:line + redacted match; <!-- scrub:allow -->
  the only escape is the explicit `scrub:allow` marker on the offending
  line. `SUSPENDERS_SCRUB=0` disables; repo-level enforcement via
  `git config core.hooksPath .githooks` (committed .githooks stubs).
- **No host-path deploys**: hub containers mount git-pulled volumes.
- **qlty is THE quality tool**; `.qlty/` must exist or the on-write gate
  silently no-ops. SPEC FIRST: read `.qlty/qlty.toml` + the biome rule set
  before the first write; never emit flagged patterns. biome owns code
  formatting; prettier owns markdown only.
- **1500-line hard limit** on any .ts — decompose, DRY the second
  duplicate, ast-grep for shareable patterns before adding near the limit.
  The on-write gate blocks past 1500; CI gates every commit
  (tests/law-guards.test.ts).
- **Shell scripts are banned** — TypeScript on Bun is the automation
  surface (LaunchAgent→bun entry points, one-line aliases only). The
  tracked .sh set is the pinned legacy exception, guarded by
  tests/law-guards.test.ts; a new .sh needs an explicit allowlist entry
  arguing why bun won't do.
- **UI engineering law**: Lit web components + CSS design tokens. NEVER
  `innerHTML`, never `document.write`. Native elements before custom.
  Lit is vendored (offline LAN — never CDN).
- **Streams over buffers**: streaming interfaces by default; NDJSON for
  logs/feeds; bounded rings with backpressure for async writes.
- **Old repos are push-dead**: all 9 originals (suspenders, belt, buckle,
  local, speedy, blam + the 3 -remotes) are ARCHIVED with redirect stubs
  (verified 2026-10-07 via gh). Every commit lands in THIS repo at
  `packages/<name>/*`; install.sh syncs the prefix from fleet
  (W422.4/W422.6 re-anchor landed).

## Working agreements

- Work graph: `work` CLI (project identity = the repo's git-common-dir —
  fleet sessions get their own identity; the historical graph lives under
  the suspenders identity until the rekey lands, W428).
- Coordination plane: coord CLI + WS subscribe; broadcast landed changes
  that affect lanes (what/who/exact command).
- Per-package AGENTS.md files are each subtree's canonical docs — they are
  the package-level truth; this root file is the stack-wide law.
- Agent skills: the repo-root `skills/` catalog installs into any agent CLI
  via `npx skills add klh/fleet` (`-g -y -a <ids>`; target ids in README
  "Install the skills as agent tools"). ChatGPT is not a CLI target — paste
  the `SKILL.md` into the conversation.

## Lane protocol (single source — package AGENTS.md files point here)

How to work here as a dispatched lane. The brief carries WHO and WHAT; this
section carries HOW.

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
   then `split --plan <id>`).
2. Work in the worktree + branch your brief names. SMALL anchored edits;
   co-situated tests for new logic; never hand-edit files another live lane
   owns.
3. **GATES** — `qlty fmt` + `qlty check` on changed files → "No issues";
   `bun test` on the files you touched → green.
4. Commit on your branch (subject = the item title), push the branch. NO tags.
5. Finish: `bun ~/.claude/hooks/suspenders/bin/work.ts done <id> --sha <branch-head>`.
   Final line: `DONE <sha>` | `SPLIT <id>` | `BLOCKED` (after 3 honest
   attempts, tree restored).

Inbox is WS-first (W303): bootstrap opens `coord subscribe --as <sid>` —
one persistent push connection, never polled. `coord inbox --as <sid>` is
the catch-up read before starting and before finishing. Narrate terse, in
plain response text — never a shell `echo`/tool call; templates are the
ENTIRE narration, no asides: a consult addressed to you → `consult: [C12]
<sid> asks …` then `consult: [C12] replying <answer>` after acting; an
answer to your consult → `consult: [C12] answered: <answer>`; fleet-wide →
`consult: fleet asks, …` / `consult: fleet, no knowledge, didn't reply` /
`consult: fleet, details forwarded`. Act first, then `coord ack <event-id>
--as <sid>` — delivery is not acceptance; reserve `coord inbox --ack` for
a fully processed inbox. Routine BROADCAST/work.landed/knowledge.settled
get no commentary.

## Supervisor reporting

`work report` renders THE supervisor reply table (owner GO 2026-10-19) —
supervisor ticks paste it verbatim. One implementation
(hooks/lib/work-report.ts); the installed face is a verbatim shim (W913).
The full contract — rows, columns, ST letters, cache floor — is
single-sourced in packages/suspenders/AGENTS.md § Supervisor reporting.

## Operations — every verb and what it is for

Shims on PATH (`coord`, `work`, `dispatch` → the installed prefix;
`~/.local/bin`, override with SUSPENDERS_SHIM_BIN). Every verb has
`--help` (per-verb usage + flags from its schema).

Work graph (`work` — the ONE ledger; never Markdown todos; every verb has
`--help`):

- `work ready` — claimable · `work list` — all (◐ claimed, ⊞ split) ·
  `work show <id>` — the item
- `work take <id> --as <sid>` — claim + mint the item worktree
  (.worktrees/<id>; W870: never treeless claims)
- `work allocate [--apply]` — scorer-ranked plan of READY × lanes
- `work done <id> --sha <sha>` — close with evidence · `work add <title>`
  — mint (never invent work)
- `work split` — fan out parallelizable work · `work lanes [--json]` —
  lane liveness (the one liveness surface) · `work reclaim all` — dead
  lanes' claims → READY

Coordination (`coord`):

- `coord subscribe --as <sid>` — WS push inbox; opened at bootstrap; NEVER
  poll with repeated probes
- `coord emit BROADCAST --scope suspenders --as <sid> --note "..."` —
  every lane-affecting landed change broadcasts same-turn
- `coord emit NEED_DECISION --to <sid> --note "q + options" --as <sid>` —
  a decision held only in your head is invisible; emit it
- `coord fact set/get/list` — fleet knowledge (`lesson.*` before
  re-deriving pain; `finding.*` for intel; IKEA content ONLY here)
- `coord consult` / `coord who-knows` — questions, never ownership
- `coord ack <event-id> --as <sid>` — accept one directed event only after
  acting on it; delivery is not acceptance (`coord inbox --ack` accepts the
  entire pending inbox — only after processing every displayed event)
- `coord coordinate` — bounded peer-coordination round (W977.1;
  docs/design/supervisor-coordination.md)
- `coord fleet` — who is working (sessions + claims; never /tmp files)
- `coord rename` / `coord project rekey` — the shared rename (W930) and
  graph identity migration (W428) — `--help` carries the grammar

Oracle (`oracle` — the named review/escalation tool, W647):

- `oracle review` / `oracle bugs` / `oracle analyze` — the fixed prompt
  contract (replaces ad-hoc "-review" phrasing in lane prompts); stateless,
  one request one answer, pinned local-reason leg (`ORACLE_ROUTE_*` are the
  config-over-code overrides); `--cloud` = the stronger cloud route. NO
  automatic stuck-detection routing — a lane or human invokes it explicitly,
  every time. Exit 0 answer · 1 usage/input · 2 leg failure.

Lanes (`dispatch`) — spawns a headless lane from READY work: brief
composed (caveman-condensed), per-lane `bksk_` key minted from
`belt.env BUCKLE_ADMIN_KEY`, rides the buckle front `/w/<sid>`, 0600
per-lane `--settings` file. No admin key = belt direct, surfaced.

Hubs (`bun deploy/hubctl.ts <verb> <hub>`) — config-over-code deploys from
`~/.config/klh/stack.yaml`. Board (:7799), buckle key endpoints, the
launchd label map, the port/process map, machine-level config paths and the
IKEA Copilot seat are reference material, single-sourced in
docs/operations-reference.md.
