# oh-my-claude (TechDufus) — research for lift/red-flag decisions

Researched 2026-10-07. Plugin v0.14.0, MIT, ~174 stars. Claude Code plugin:
18 Python hooks (PEP 723, run via `uv run --script`), 7 subagents, 12 skills,
1 command (`/prime`), 2 bundled MCP servers. Inspired by oh-my-opencode.

Read in full: README, PLUGIN-STRUCTURE.md, hooks.json, all 18 hooks
(hook_utils, safe_permissions, todo_enforcer, context_monitor,
precompact_context, ultrawork_detector, context_guardian,
plan_execution_injector, claudemd_health, danger_blocker,
commit_quality_enforcer, tdd_enforcer, delegation_enforcer,
edit_error_recovery, agent_usage_reminder, verification_reminder,
notification_alert, openkanban_status), install.sh, .mcp.json,
plugin.json/marketplace.json, agents (advisor, critic, librarian,
validator), /prime, skills (ralph-loop-init, ralph-plan, init-deep,
worktree). Branch `master`.

Overlap with prior oh-my-opencode pass (W502 Stop-gate continuation
enforcer, W503 keyword fan-out posture, W504 per-provider concurrency
caps): NOT re-proposed here. ultrawork keywords and the Stop-gate
continuation loop are near-identical to what W502/W503 already lifted —
the only genuinely new Stop-gate detail is noted as a W502 fold-in (L8).

## Executive summary

oh-my-claude is a prompt-and-hooks orchestration overlay: it shapes a
single Claude Code session into an orchestrator (inject "delegate
everything" SOP at SessionStart), gates plan approval behind a critic
subagent, nags on context pressure, preserves state before compaction,
and auto-approves a curated safe-Bash list. No model routing, no cost
telemetry, no multi-session coordination — none of its mechanisms span
sessions except `.claude/plans/.active-plan.json`.

Verdict: three mechanisms are worth lifting (L1–L3), four are cheap
conveniences (L4–L7, L8), the runtime substrate (uv + npx MCP) is a
hard no for this fleet, and its session-scoped state layer (todos,
plans, ralph loops) is strictly weaker than governor.db.

## 1. Lifts

### L1 — Critic gate before plan execution (advisor → plan → critic)

**What.** `permission_mode == "plan"` auto-injects a 6-step SOP
(ultrawork_detector.py): quick recon → informed interview (AskUserQuestion
referencing recon findings, saved to `.claude/plans/drafts/`) → deep
research → mandatory advisor gap-analysis → write plan with a fixed
contract (TL;DR / Big Picture Intent / Must-NOT guardrails / per-task
file:line refs + runnable acceptance command) → mandatory critic review
(loop until `APPROVED`) before ExitPlanMode. On ExitPlanMode,
plan_execution_injector.py injects a plan-compliance execution context,
writes `.claude/plans/.active-plan.json` (status/session_id) for
cross-session recovery, and deletes the interview drafts.

**Why it works.** The two gates are injected as hook context, not
trusting model goodwill: advisor findings feed the critic prompt; critic
verdict is the loop condition. The plan contract forces evidence
(file:line, runnable acceptance) per task — the same
"evidence before assertions" law we already run, but applied at plan
granularity. "Big Picture Intent" (original problem / key constraints /
primary driver) is a cheap tiebreaker for mid-execution judgment calls.

**Fleet mapping.** Our dispatch briefs are composed once and consumed
once; there is no plan→critique→approve lifecycle on a work item. Two
non-exclusive adoption points:

- Brief composition (dispatch loop): before a lane takes a split item,
  run a cheap critic pass (local :8903 reason tier) over the brief;
  refusal = item goes back to NEED_DECISION.
- ExitPlanMode hook (interactive sessions): write the active-plan state
  - critic verdict into the work item (`work add --desc` or a fact), so
    a relaunched lane inherits the approved plan, not a stale brief.

**Choose between.**

- (a) Prompt-only SOP in dispatch brief templates — trivial, no
  enforcement, drifts.
- (b) Hook-enforced: PreToolUse/ExitPlanMode gate in suspenders that
  blocks plan execution until a critic verdict exists — moderate,
  deterministic, matches our gate doctrine.
- (c) Skip: our `work split` is already plan-gated beyond 2 children —
  partial coverage only (single-item briefs get no critique).

Recommended: (b) for brief composition, plus the plan-state file only
if (b) lands.

**Effort.** moderate.

### L2 — Context-pressure telemetry with native percentage + once-per-threshold dedup

**What.** context_monitor.py (PostToolUse `.*`) reads the native
`context_window.used_percentage` from hook input (falls back to
chars/4 vs 200k), warns at 70% and 85% (`OMC_CONTEXT_WARN_PCT` /
`OMC_CONTEXT_CRITICAL_PCT`), and dedups via
`/tmp/omc_context_{session}_{threshold}` marker files so each threshold
fires exactly once per session. Warning text is directive: "70% full
means context tax on every operation. Delegate now."

**Why it works.** Context exhaustion is invisible until the model
degrades; the native field (no estimation) plus one-shot thresholds
gives a signal without nag spam.

**Fleet mapping.** Our lanes die mid-work on context collapse; the
watchdog reaps them but the work is lost until reclaim. A 70/85% signal
is the natural trigger to checkpoint: at 70% inject "write progress +
capsule now"; at 85% inject "close or hand off the item". Lands as a
PostToolUse hook in suspenders, or belt-side for statusline display.

**Choose between.**

- (a) PostToolUse hook that injects checkpoint directives at thresholds
  — moderate, actionable, per-lane.
- (b) Belt statusline/board metric only (visibility, no behavior
  change) — trivial but cosmetic.
- (c) Skip: dispatch already sizes items small — does not help long
  research lanes.

Recommended: (a), thresholds as fleet config, not code constants.

**Effort.** moderate (trivial if only the estimation fallback is
wanted; native field needs a current Claude Code version check).

### L3 — PreCompact semantic state preservation

**What.** precompact_context.py (PreCompact) emits via `systemMessage`
a `<context-preservation>` block built from: git state (branch, status,
staged capped 10), files touched in HEAD~5, active mode, top-5 todos,
and regex extraction over the last 20 transcript messages of problems /
solutions / decisions / file paths (capped 5/5/5/10, 80-char snippets).

**Why it works.** Compaction is where long lanes lose the thread; the
surviving summary is model-generated under pressure. A cheap,
deterministic extraction of "what were we fixing, what did we decide"
survives the summarizer.

**Fleet mapping.** Complements our Stop-gate session-end learnings ask:
that captures durable lessons (coord facts); this captures in-flight
state. Our emission-corruption discipline already has the mechanics for
where such a block would go — a capsule file the relaunched lane reads
at bootstrap (dispatch already writes briefs to `.fleet/brief-<sid>.md`;
a sibling `precompact` capsule is the same pattern).

**Choose between.**

- (a) PreCompact hook writing `.fleet/state-<sid>.md` + bootstrap reads
  it — moderate, closes the relaunch-amnesia gap.
- (b) Fold extraction into the existing Stop-gate learnings ask
  (already runs session-end) — trivial, but misses hard compactions
  that never reach a clean Stop.
- (c) Skip: coord facts + governor.db hold durable state — true for
  decisions, false for in-flight debugging state.

Recommended: (a); (b) only if (a) is rejected as surface creep.

**Effort.** moderate.

### L4 — Bash-gate hardening primitives (safe_permissions.py)

**What.** A PermissionRequest auto-approver (env-gated, default ON)
with genuinely good parsing hardening:

- quote-aware compound-command splitting (`&&`, `||`), rejecting bare
  `|`, `;`, `&`
- shell-operator rejection for unquoted `[|><;&\`()()]`
- redirect safety: every `>`/`>>` target must realpath-resolve inside
  cwd; input redirects rejected
- catastrophic hard-deny list (rm -rf /, ~, sudo rm -r, dd to block
  devices, mkfs, fork bombs, chmod -R 000 /)
- `is_plugin_internal_script`: strips interpreter prefixes, then
  realpath-checks the script lives under the plugin root — fixes a real
  substring-spoofing bug (`rm -rf / #/path/to/plugin` used to match)

**Why it works.** Allowlist bugs auto-approve; they fixed the one found.
The primitives (not the auto-approval) are the asset.

**Fleet mapping.** Our PreToolUse content gate parse-checks Write/Edit
payloads; Bash evaluation rides Claude Code permissions. The sanitizers
port 1:1 into a Bash matcher in the suspenders gate (TypeScript, bun)
— as deny-verification behind our ask-first posture, not as an
auto-approver.

**Choose between.**

- (a) Port sanitizers + catastrophic list into our gate as an extra
  deny layer — moderate, defense-in-depth, no behavior change for the
  owner.
- (b) Also adopt scoped auto-approval for lanes only (per-lane bksk_
  lanes are already non-interactive) — deep, real speedup for lanes,
  but changes the blast radius story; needs owner sign-off.
- (c) Skip — Claude Code's native permission system plus human approval
  is the boundary (our "gates are guard-rails not boundaries" finding
  argues a deny layer is still worth it).

Recommended: (a). (b) only as a fleet experiment on the desktop hub.

**Effort.** moderate (a) / deep (b).

### L5 — Stack-detect validation commands (detect_validation)

**What.** cwd sniffing (package.json / pyproject / go.mod / Cargo.toml /
Makefile) → one concrete validation command string injected into the
execution directive ("TypeScript/JS: npm run typecheck && npm run lint
&& npm test").

**Why it works.** Removes per-lane guessing about what "verify" means;
makes the verification demand in every directive concrete and runnable.

**Fleet mapping.** One function in the dispatch brief composer (bun,
typed). Fleet twist: read it from qlty config or package scripts, not
hardcoded per-ecosystem strings — our repos are qlty-first, and the
project law says config-over-code.

**Choose between.**

- (a) Brief-composer injection from qlty/package metadata — trivial.
- (b) Skip: lanes already discover this from AGENTS.md/CLAUDE.md —
  costs each lane a read to re-derive.

Recommended: (a) for `dispatch`-spawned lanes.

**Effort.** trivial.

### L6 — Parseable agent verdict contracts (agents/*.md)

**What.** Every specialized agent .md carries: `disallowedTools: Write,
Edit` (read-only by construction), `model: inherit`, and a fixed
"Output Minimum" shape ending in a machine-parseable final line —
validator: `VERDICT: PASS` / `VERDICT: FAIL - <reason>`; critic:
`APPROVED | NEEDS REVISION | REJECTED`; advisor: `CLEAR | GAPS_FOUND |
INSUFFICIENT_CONTEXT`; all with mandatory Uncertainty (assumptions /
unknowns / confidence).

**Why it works.** A parent can verify the subagent result structurally
(final-line regex) instead of semantically; write-disallowed reviewers
cannot mutate what they review.

**Fleet mapping.** Our paired-lane protocol transfers findings via
SendMessage prose; the claim-owner verifies by re-reading. A verdict
line contract in brief templates + a SendMessage-side parse would let
the writer lane fail fast on `FAIL`/`NEEDS REVISION` without semantic
interpretation. Distinct roles we lack (advisor = pre-plan gap
analysis) map to pre-`work split` checks.

**Choose between.**

- (a) Verdict-line convention in brief/fact templates only — trivial.
- (b) Enforced: Stop/post-SendMessage check that a lane's final transfer
  message parses — moderate, brittle against prose-y lanes.

Recommended: (a).

**Effort.** trivial (a) / moderate (b).

### L7 — CLAUDE.md instruction-budget audit (claudemd_health.py)

**What.** SessionStart lint of CLAUDE.md: >100 lines, >150 estimated
instructions (bullet + imperative-verb heuristic), hardcoded file paths
(staleness risk), and suggestions for nested CLAUDE.md (closest file
wins). Paired with the init-deep skill's doctrine: root 50–150 lines,
nested 30–80, children never repeat parents, directory scoring for
where nested files earn their keep.

**Why it works.** Instruction capacity (~150-200 directives) is real;
a bloated root CLAUDE.md taxes every session, forever.

**Fleet mapping.** Our root CLAUDE.md is dense by design (laws + ops
verbs) but several sections are machine-facing and belong in per-package
AGENTS.md (which the project CLAUDE.md already defers to). Worth a
one-off audit pass with this rubric, not a runtime hook.

**Choose between.**

- (a) One-off audit: run the heuristic over fleet CLAUDE.md/AGENTS.md
  files, move machine-facing ops detail out of the root — trivial, no
  runtime cost.
- (b) SessionStart hook — adds per-session latency for a static
  property; skip.

Recommended: (a), as a qlty-adjacent script if it proves out.

**Effort.** trivial.

### L8 — Fold-in: premature-stop phrase detection (into W502)

**What.** todo_enforcer.py (Stop gate) blocks a stop when the last
assistant message matches farewell-y patterns ("let me know if you…",
"shall I proceed", "want me to") while uncommitted changes exist —
catching the "end conversation politely instead of finishing" failure
mode. Also: post-work staging (todos complete + no validation run →
block demanding validation; validation run → block demanding a
completion summary before allowing stop).

**Why.** Distinct trigger from W502's continuation enforcement (which
fires on incomplete work): this fires on polite-stop with dirty tree,
and on "work done but never verified". Small, composable.

**Fleet mapping.** Fold as an additional condition into the existing
W502 Stop-gate gate — premature-stop phrase + dirty worktree (or
claimed-but-unsha'd work item, which is our stronger equivalent of
"uncommitted changes") → block. The completion-summary demand maps to
our `work done --sha` requirement; the validation-demand maps to our
verify-with-real-output law and is largely already enforced upstream of
the gate.

**Choose between.**

- (a) Phrase+dirty-tree condition added to W502 — trivial.
- (b) Skip — W502 plus work-graph state may already cover the cases;
  only add if W502 logs show polite-stops slipping through.

Recommended: check W502 block logs first; add (a) only on evidence.

**Effort.** trivial.

## 2. Red flags (scrutiny points before any install)

Nothing here is installed or proposed for install. If any of it ever
is, `skill-security-review` on the exact source ref first. Flagged by
severity:

1. **Bundled MCP servers via unpinned `npx -y`** (`.mcp.json`):
   `@modelcontextprotocol/server-sequential-thinking`,
   `@upstash/context7-mcp`. Installing the plugin registers two MCP
   servers that fetch arbitrary npm packages from the network at
   runtime, unpinned. Hard no for the offline-LAN fleet (Lit is vendored
   specifically to avoid CDN fetches); online it is standing
   supply-chain exposure. Scrutinize: every entry in any `.mcp.json`,
   pinned versions or reject.

2. **`uv run --script` on every hook invocation, 18 hooks deep.** uv
   resolves a Python interpreter and (mechanism permits) inline PEP 723
   dependencies per run — declared empty today, but a version bump can
   add arbitrary PyPI fetches that execute on every tool call. The
   plugin's entire behavior surface is re-fetched, unversioned-locked
   code executed constantly. Scrutinize: `dependencies = []` in every
   hook header, and whether uv is configured offline; treat any
   non-empty dependency block as remote code execution by design.

3. **install.sh pipes astral.sh to `sh` and rewrites
   `~/.claude/settings.json`** (jq merge, `.bak` backup). The manual
   install path is curl|sh plus direct mutation of user settings. The
   marketplace path does not run it, but the repo ships and documents
   it. Scrutinize: any installer that mutates settings.json — our
   settings-merge behavior is already a known foot-gun
   (settings-env-clobber).

4. **Default-ON auto-approval** (`OMC_SAFE_PERMISSIONS` default
   enabled): PermissionRequest hook auto-approves broad Bash classes
   (git readonly, test runners, file readers) with `has_shell_operators`
   / redirect-containment hardening. Even done well, this shifts the
   trust boundary from human to regex allowlist — and its own history
   (substring-spoofing bug on plugin script paths, since fixed) shows
   the failure mode: allowlist bugs auto-approve. Conflicts with our
   ask-before-irreversible law. Scrutinize: SAFE_PATTERNS list against
   current CLAUDE.md semantics, redirect/realpath logic, and any
   auto-allow of the plugin's own scripts
   (`is_plugin_internal_script` bypasses version review of the very
   code being allowed — self-privileging by design).

5. **Prompt injection by design, anti-consent framing.** SessionStart
   conductor-SOP, ultrawork's "NO QUESTIONS / NEVER ask 'proceed?' /
   permission-asking is eliminated" / ZERO TOLERANCE tables,
   todo_enforcer's "CONTINUE WORKING NOW" + anti-rationalization
   blocks. All intentional behavior shaping — in your own tool, fine;
   as an overlay it systematically suppresses the model's asks and
   human approval gates, and its "NEVER downgrade models" directive
   contradicts our operator-owned routing ladder
   (routing-policy.yaml). Scrutinize: every injected context string for
   directives that override owner-facing confirmation behavior.

6. **Attribution policy conflict (not security).**
   commit_quality_enforcer.py hard-blocks commits containing
   `Co-Authored-By: Claude` or robot emoji. Our commits carry
   `Co-Authored-By: Claude Code` per harness policy. Installing any
   piece of this hook would fight our own commit discipline.

Clean findings (scoped to what was read): hooks are stdlib-only with
subprocess limited to git / osascript / notify-send / powershell; no
outbound HTTP in hook code, no secrets access, no telemetry calls, MIT
license. `notification_alert` is opt-in (`OMC_NOTIFICATIONS=1`) and
AppleScript/PowerShell-sanitizes interpolated strings. `openkanban`
writes only when its env var is set, to `~/.cache/openkanban-status/`.
The residual trust problem is substrate-level (items 1–2), not
spying-in-the-hooks.

## 3. Worse than what we already have

- **Ephemeral transcript-todo state vs governor.db.** todo_enforcer
  infers todo state from TodoWrite/TaskList tool_results in the session
  transcript — in-session, gone at /clear, spoofable by transcript
  content, and the `validation_ran` heuristic is regex-on-transcript
  ("validator" mentioned anywhere). Our work graph is transactional,
  project-scoped, cross-lane, closed with shas. Their whole todo
  enforcement layer is a weaker ledger. Only L8 (phrase detection)
  survives as an add.
- **`.claude/plans/*.md` + drafts vs work items + briefs.** File-based
  planning state with no identity, ownership, or claim semantics. Ours:
  `work take`/`done --sha`, per-project scoping, unfilled-mission
  detection. Their `.active-plan.json` is a single slot per repo.
- **ralph loop (prd.json + loop.py) vs dispatch loop + watchdog.** An
  unsupervised external while-loop that shells Claude per iteration.
  Ours is launchd-supervised, progress-reported, liveness-voted,
  ghost-reaped (`work reclaim all`). Adopting ralph would be a
  regression on every axis we fixed in W500-era work.
- **/prime context recovery vs governor.db bootstrap.** Re-derives
  state by scanning git+gh+CLAUDE.md (~500–800 tokens) because it
  assumes no durable state layer. Our sessions bootstrap from the work
  graph and coord — authoritative, not reconstructed.
- **Python/uv hook substrate vs TypeScript-run-by-bun doctrine.** Every
  hook is a uv+Python process spawn (cold ~300ms+); wired on `.*`
  matchers across 5 events (openkanban) that is 5+ spawns per tool
  call. Our hooks are in-process bun. Keep their mechanisms, never
  their runtime.
- **Keyword fan-out (ultrawork) = W503.** Already lifted; the
  oh-my-claude variant adds only a trivial-request escape hatch (light
  touch note for question-without-action-verb prompts) — worth a
  one-line port into the W503 directive if we ever see over-orchestration
  of simple asks, otherwise nothing new.

## 4. Not applicable

- Model routing ladders, cost telemetry: absent from the project (their
  agent frontmatter is `model: inherit` everywhere; "NEVER downgrade
  models" is the opposite of our ladder). Our routing-policy.yaml is
  strictly ahead.
- Session lifecycle across lanes: nothing beyond `.active-plan.json`;
  no coordination plane. Our coord WS + work graph has no peer here.
- danger_blocker / tdd_enforcer / delegation_enforcer /
  edit_error_recovery / agent_usage_reminder: single-session prompt
  nudges duplicating laws we already enforce structurally (content
  gate, qlty, W64 edit discipline, paired-lane locks).
