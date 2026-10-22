# Agent-management tools 2026 — what fleet should lift

2026-10-22 · W1133 · lane autow1133. Survey of the 2026 agent-management
layer (source: nimbalyst.com/blog/best-agent-management-tools-2026,
published 2026-06-01, updated 2026-07-29) against fleet's own stack.
Companion docs: research-awesome-harnesses-2026-10-18.md (W794 — covered
kanban orchestrators + session-continuation mechanisms; this doc covers
the operator-surface layer and names only delta) and W1134 (Nimbalyst
knowledge angle — wiki/Context Graph; not re-derived here).

## Source quality

The article is a vendor post (Nimbalyst's CEO) — first-tier for its own
product only. Repo claims below verified via GitHub API + READMEs
2026-10-22 unless marked (article). No GUI was installed: fleet runs
headless-first, so every tool is judged at source level.

## Fleet baseline — the article's five categories

| Category          | Fleet today                                                                                     | Grade                                            |
| ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Session visibility | fleet-board lanes + belt dashboard :7791 + watchdog (`.fleet/stall.json`, fleet-loop/stall-watch.ts) | weak — liveness ghosting open (W1072)            |
| Isolation         | per-item worktrees, minted by `work take` (W870)                                                 | strong                                           |
| Review            | merge ladder + diff evidence + scrub/content gates                                               | strong                                           |
| Organization      | work graph (one ledger) + board cards                                                            | strong                                           |
| Recovery          | capsule hand-off + fleet-loop re-dispatch + stall-watch + rogue-reap                              | partial — no replay/resume; resume fidelity = what the lane banked |

## Comparison

Verdict per row (benchmarks doctrine — each row chooses): **LIFT** =
steal the named feature, **PARK** = revisit when a precondition lands,
**REJECT** = don't adopt, with reason. Adoption of any of these as
fleet's surface is out of scope — the board/graph ARE the product; every
verdict is about mechanisms.

| Tool (verified 2026-10-22)                                                                       | What it is                                                                                              | Does that fleet doesn't                          | Verdict                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Vibe Kanban — BloopAI/vibe-kanban, 28.4k★, Apache-2.0; README carries its own sunset banner        | Board-first agent kanban; workspaces = branch + terminal + dev server; inline diff comments → agent feedback; built-in browser preview w/ device emulation; 10+ harnesses; AI PR descriptions | Inline diff-comment → agent loop; app-preview pane | LIFT the diff-comment → agent loop (board shows diff evidence but has no comment channel); PARK the preview pane; REJECT adoption (sunsetting, community-maintained) |
| Conductor — closed Mac app (conductor.build, no public repo)                                      | Per-agent worktree desktop UX, diff viewer, PR flow                                                      | Nothing structural — worktree-per-agent is W870   | REJECT — closed, Mac-only, no API face to integrate; UX parity with board + worktrees                  |
| Claude Squad — smtg-ai/claude-squad, 8.6k★, AGPL-3.0                                              | tmux TUI, worktree per task, yolo/auto-accept, review-before-apply                                       | A ready-made TUI ops face                         | REJECT — fleet is headless + board/CLI; a tmux layer duplicates dispatch; auto-accept is partly covered by per-lane allowlist settings (W1121 generalizing) |
| Nimbalyst — MIT desktop + iOS (was Crystal)                                                       | Visual workspace + kanban; native iOS app: review diffs, resume sessions, monitor from phone             | Native mobile oversight; resume-from-elsewhere    | LIFT the oversight shape as a responsive/PWA board pass (read-mostly); REJECT a native app; knowledge angle = W1134 |
| Superset — superset-sh/superset, 15.5k★, license NOASSERTION                                      | Agentic IDE: terminals, Changes pane, browser pane with Design mode (select element → prompt with element context), PR review with diff-line feedback to a running/new session | Element-context feedback; diff-line-scoped feedback | LIFT diff-line-scoped feedback (merges with the Vibe Kanban loop); PARK element-context (needs a preview pane); REJECT adoption (it is an IDE platform, not an operator layer) |
| Paneflow — arthjean/paneflow, 87★, GPL-3.0, Rust/GPUI + libghostty                                | Native pane multiplexer; sessions persist when the app closes; read/interrupt/take-over any terminal; gated auto-submit | Interactive takeover of a running session         | LIFT the takeover shape — validates the W1035 steering endgame (steer is Codex-only today, hooks/lib/codex-steer.ts; Claude lanes get interrupts via lane-inbox but no attach); PARK native panes |
| Sculptor — imbue-ai/sculptor, 240★, MIT, research preview                                         | Each agent in a Docker container; merge only on approval; pairing mode; built-in skills (fix-bug: repro interview → failing tests → pass) | Container isolation instead of worktrees          | LIFT container-per-lane as an ENTERPRISE policy tier (stronger than worktree sandbox; fits the W775 policy-tier arch — a pack, not a fork); REJECT adoption (experimental, no harness breadth) |
| Mux → Xum — coder/mux (renamed after a trademark dispute), 2.1k★, AGPL-3.0                        | Desktop + browser app; local/worktree/SSH runtimes; multi-model with Ollama/OpenRouter; VS Code extension | Lanes running on remote compute over SSH          | LIFT remote-runtime lane execution — dispatch → lane on a hub machine (NAS/desktop); fleet's hubs serve gates/routers but lanes never ride them; REJECT adoption (custom agent loop duplicates the harness layer) |
| Opcode (ex-Claudia) — winfunc/opcode, 22.4k★, AGPL-3.0                                            | Single-session Claude Code GUI + background agents                                                       | Nothing                                           | REJECT — unmaintained (last push 2026-09-18, article concurs), Claude Code-first                       |
| tmux + scripts (pattern, not product)                                                             | DIY panes/worktrees/branch-tracking                                                                      | Nothing fleet doesn't already systematize         | REJECT — fleet IS the industrialized version; the pattern's own lesson is maintenance burden           |

## Lift-list (concrete, ranked)

1. **Inline diff-comment → agent feedback loop** (Vibe Kanban, Superset).
   Board diff evidence + coord message exist; missing is the binding:
   comment on a diff hunk in the board → lands as a directed lane message
   (coord message / lane-inbox) → consumed on the lane's next turn. Small
   board change + one relay; the largest UX delta in the category.
   W858.7-adjacent.
2. **Remote-hub lane runtime** (Xum SSH runtime). dispatch spawns
   host-local processes; hubs serve services only. A
   `--runtime remote:<hub>` that ships the worktree to the hub volume and
   runs the lane there adds real parallelism + hardware isolation.
   Highest engineering cost on this list; the only one that changes what
   fleet CAN run, not just see.
3. **Container-per-lane enterprise tier** (Sculptor). Above worktrees:
   container isolation as a policy-pack overlay (W775 arch: pack +
   overlays, never a base fork) for untrusted/enterprise lanes where the
   sandbox must not be bypassable by the lane itself.
4. **Session replay from existing events** (Nimbalyst resume; hankweave
   journals per W794). Work-graph events + coord events + gate verdicts
   already carry the payloads; nobody renders them as a per-lane
   timeline. A board lane-detail "replay" tab is a rendering problem, not
   a capture problem. Pairs with W1072 — replay doubles as the audit
   face.
5. **Mobile oversight pass** (Nimbalyst). Responsive/touch pass + PWA on
   belt.local:7791 — read-mostly (lanes, READY, NEED_DECISION). Reject a
   native app until the read face earns daily use.
6. **"Needs attention" lane badge** (Paneflow activity tracking).
   NEED_DECISION + blocked + stall-watch signals already exist as events;
   a board badge per lane is a small render.

Parked, not lift-listed: app-preview pane + element-context feedback
(Vibe Kanban browser, Superset Design mode) — real features, but fleet's
own surface is not a GUI app; relevant only if board work wants an inline
preview of Lit components.

## Reject-list

- Adopting any tool here as fleet's surface — the work graph + board is
  the product; a wrapper would fork the ledger.
- Conductor, Claude Squad, Opcode, tmux DIY — no mechanism fleet lacks;
  closed / maintained-elsewhere / duplicate (table above).
- Native mobile app — a PWA gets read-oversight for a fraction of the
  cost.
- Superset as IDE — it competes with the harness layer instead of sitting
  above it.
- Sculptor adoption — research preview; take the isolation idea, not the
  tool.
- Yolo/auto-accept modes (Claude Squad) — per-lane allowlist settings
  already gate this; W1121 generalizes it into a typed grammar.

## Bottom line

Category parity: organization, isolation, review — fleet at or above;
the article's "harness wrappers vs workspace layers" split already lands
fleet in workspace-layer territory. Real gaps, in order: (1) the review
loop is brief-mediated, not diff-inline; (2) lanes run on one host only —
no remote runtime; (3) recovery banks capsules but cannot replay a
session, though the event data for it already exists; (4) container
isolation absent — an enterprise-tier candidate. None of these require
adopting anything; all are buildable on the existing plane.
