# Research: oh-my-claudecode (OMC)

Researched: 2026-10-07. Method: read repo master (README, SECURITY.md, docs/HOOKS.md, docs/ARCHITECTURE.md, docs/DELEGATION-ENFORCER.md, docs/TEAM-WORKTREE-MODE.md, docs/OPENCLAW-ROUTING.md, hooks/hooks.json, and six hook scripts in full: context-guard-stop, workflow-drift-guard, pre-tool-enforcer, verify-deliverables, post-tool-use-failure, session-end), npm package listing, ohmyclaudecode.com.

Stance: nothing installed, nothing to install. Every good idea below is a mechanism we re-implement in our own TypeScript under fleet law (install-grade, reviewed). Third-party skills/plugins are prompt+code injectors — `skill-security-review` on an exact pinned ref would be mandatory before any install, and this doc argues we should not install at all.

## What OMC is

MIT plugin + CLI by Yeachan Heo (~37-39k stars), "multi-agent orchestration for Claude Code". Two distribution routes with different trust chains: (a) Claude Code plugin marketplace from the GitHub repo, (b) the npm package `oh-my-claude-sisyphus` — note the package name does NOT match the brand. 21 hooks across 11 Claude Code lifecycle events, 19 agents (tier variants), 31 skills, a `.omc/` state directory, tmux CLI workers for external providers (codex/gemini/antigravity/grok/cursor), and an SDK surface on `@anthropic-ai/claude-agent-sdk`. Release velocity is days, not months: master's package.json read at 4.15.2 while npm listed 5.5.0 the same day — the exact skew makes version pinning mandatory for anyone adjacent to it.

| Event                     | Hooks                                                        | Gist                                                                                                      |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| UserPromptSubmit          | keyword-detector, skill-injector                             | magic keywords ("ralph", "autopilot", "don't stop") activate skills/modes                                 |
| SessionStart / SessionEnd | session-start/end, project-memory, wiki                      | state restore, session JSON, notifications (async on end)                                                 |
| PreToolUse                | pre-tool-enforcer                                            | model routing enforcement + injection on Task/Agent, agent-spawn preflight, slop warning, advisory nudges |
| PostToolUse / Failure     | post-tool-verifier, failure                                  | retry counter, guidance, noise suppression                                                                |
| SubagentStart/Stop        | subagent-tracker, verify-deliverables                        | spawn tracking, deliverable existence check                                                               |
| PreCompact                | pre-compact, project-memory, wiki                            | flush state to notepad before compaction                                                                  |
| Stop                      | context-guard, drift-guard, persistent-mode, code-simplifier | context pressure, fake-completion scan, mode continuation                                                 |

## 1. Worth lifting

Ordered by expected value. Effort classes assume our hook/gate stack (`packages/suspenders/hooks/gate.ts` + `gates/*`, work CLI, coord bus).

### 1.1 Context-pressure Stop guard

What: at Stop, OMC estimates context usage by reading the last 4 KB of the session transcript and matching `context_window` / `input_tokens`; at >= 75% (env-tunable) it blocks the stop once with "run /compact now", capped at 2 blocks per session; at >= 95% (critical) it lets the stop through, and it NEVER blocks a context-limit-caused stop or a user abort (blocking those deadlocks compaction). Retry state lives in a small per-session guard file.

Why it works: it converts the silent context-exhaustion failure mode (lane drifts into compaction mid-claim, loses in-flight state, or dies) into one cheap, bounded intervention. The caps and never-block rules are what make it safe — most naive versions of this hook loop or deadlock.

Fit: extend `hooks/gates/stop.ts`. Highest value on lanes: long headless runs are exactly where context exhaustion goes unnoticed until the claim is lost. The idle reaper (W500) watches liveness; this watches capacity.

Decision — two implementation postures, pick one:

- Stop hook (in-session, acts before teardown): consistent with our existing gate chain, sees the transcript natively. Con: in-process, so per our own health law it cannot be the thing that reports lane health.
- Probe metric (outside-process): the watchdog/belt-side reaper reads the same transcript tail as a liveness-adjacent signal and escalates via dispatch. Con: coarser, reactive.

Not exclusive: hook to act, probe to observe. Effort: moderate.

Required sub-component (bug we would otherwise hit): worktree transcript resolution. Claude Code encodes transcript paths per-CWD; inside a linked worktree the transcript lives under the main repo's encoded project dir. OMC's fix (their issue #1094): if the transcript path doesn't exist, strip the `--claude-worktrees-<name>` segment, else resolve via `git rev-parse --git-common-dir` and look under the main repo's encoded projects dir. Every transcript-reading gate we build for worktree lanes needs this. Effort: trivial standalone.

Adjacent caution from the same codebase (their issue #354): never scan the global `~/.claude/todos/` for progress accounting — it accumulates across all sessions and projects and yields phantom counts. Encode this in any progress-reading code now.

### 1.2 Fake-completion scan at close-out

What: OMC's workflow-drift-guard (Stop) runs only when the final assistant message claims completion, then scans the ADDED lines of `git diff HEAD` plus untracked files for deterministic blockers: `test.skip`/`test.only`, placeholder TODOs ("TODO: implement/fix/wire"), `throw new Error("TODO"/"Not implemented")`, placeholder returns with stub comments, explicit stub/placeholder implementations. Hit = block with the file:line list. It strips string/regex literals before scanning to avoid false positives, caps output at 8 findings, respects `stop_hook_active`, fails open.

Why it works: "done" claims are cheap; this makes the cheapest lie (claim done while leaving stubs) structurally expensive. It is fully deterministic — no model, no judgment, no flakiness.

Fit: this is NOT the W502 continuation enforcer (which re-prompts on stop); it is close-out evidence enforcement. Natural home: the `work done --sha` path in the work CLI — scan the diff between the claim's base and the close sha for the blocker patterns; on hit, refuse the close unless the item carries an explicit `blocked-on` declaration (owner-visible, not silent). Complements our existing gates, which police HOW writes happen, not whether "done" is honest.

Decision: gate in `work done` (deterministic, evidence lives in the graph) vs Stop-hook variant (fires even without the work graph, but noisier). Prefer `work done`; it is where our completion claim already lives. Effort: trivial-to-moderate (the regex set is copyable from the cited script).

Optional pattern from the same hook: blocking prose questions ("should I...?", "which option?") at Stop to force structured AskUserQuestion. Lower value for us — our lanes are briefed, not conversational. Skip unless lane churn from vague questions shows up in friction data.

### 1.3 Task-layer model pinning

What: OMC's PreToolUse hook intercepts `Task`/`Agent` calls and, when no explicit model is set, injects the configured per-agent model via `hookSpecificOutput.updatedInput` (their issue #3242) — rewriting the tool call itself, not the environment. In forceInherit/proxy modes it instead DENIES calls whose model param cannot resolve on the active provider (tier aliases without a safe target, `[1m]`-suffixed session models that subagents would inherit and fail on), with actionable guidance.

Why it works: agent-definition and env-based model selection are advisory; the tool call is the point of execution. Rewriting there is deterministic, per-call, and observable in debug logs.

Fit: directly attacks a known wound — settings-env-clobber (claude-code merges user settings env OVER process env; dispatch model pins die on arrival; today we work around with per-lane 0600 settings files). A PreToolUse gate reading a `subagent_type -> tier` map derived from `routing-policy.yaml` (operator-owned, per the ladder law) and injecting the tier via `updatedInput` makes pins survive whatever the env merge did.

Decision: tool-layer pin via hook (deterministic at the call site, new gate needed) vs current per-lane settings files (works, but per-lane ceremony and still env-adjacent) vs belt-side routing by alias only (already possible, but cannot force a lane that never passes a model). The hook composes with belt routing — pin the tier, let the ladder resolve the concrete model. Effort: moderate.

### 1.4 PreCompact claim-state flush

What: on PreCompact, OMC writes in-flight state (progress, next steps, critical context) to a notepad file that is re-injected at the next SessionStart; project memory is flushed under a file lock so parallel sessions can't lose updates (they added the lock after real lost-update races).

Why it works: compaction is a lossy summarizer; anything not written to disk before it fires is gone. Flushing BEFORE compaction, not after, is the whole trick.

Fit: our lanes hold claims in the work graph but in-flight findings live only in context (paired-lane findings move via SendMessage, i.e. manually). A PreCompact gate could flush: active claim id, progress-so-far, findings, next-step list — to a `.fleet/` state file (or a coord message) that the SessionStart bootstrap re-injects. This is session lifecycle management we currently do not have; long lanes hitting compaction today lose exactly this.

Decision: flush to `.fleet/claim-state-<sid>.md` (simple, file-shaped, matches brief convention) vs coord message (rides the bus, but interrupt-only semantics make it a bad store) vs work-item comment (no such verb today — would need a work CLI verb, which per control-plane law means registering one, not hacking the DB). Prefer the file for v1. Effort: moderate.

### 1.5 Tool-failure retry counter with anti-thrash guidance

What: OMC's PostToolUseFailure hook records the last tool error per session (name, input preview, error, timestamp) under a real file lock, counts retries within a 60 s window, and injects guidance: "failed, analyze and continue" — upgraded at >= 5 retries to "stop retrying the same approach; change method or ask". It also suppresses known noise (find/grep permission-denied scan spam, optional-startup `method not found`) and never fires on user interrupts.

Why it works: retry loops are a top lane time-sink; a deterministic counter that changes the NUDGE at a threshold converts thrash into a strategy change without owner involvement.

Fit: our `hooks/lib/failure-recovery.ts` dedupes governor-denial incidents into consults — cross-session, coordination-plane. This is the missing in-session complement: same event class (PostToolUseFailure), different altitude. Effort: trivial.

### 1.6 Advisory throttle (dedupe repeated hook messages)

What: OMC's PreToolUse advisory emission is keyed by sha256 of the message with a 5-minute per-session cooldown (configurable), capped at 100 entries, written atomically (tmp+rename, 0600), and fails OPEN on state IO errors — throttling must never silence a safety message.

Why it works: identical advisories injected on every tool call burn context and train the model to ignore them. Cooldown-by-content keeps the nudge novel.

Fit: our PostToolUse gates emit advisories per write; a content-keyed cooldown slot (in the session's state dir or governor.db) is a small, self-contained addition to the gate chain. The fail-open rule matches our own gate doctrine. Effort: trivial.

### 1.7 W502 amendment: budgeted continuation

What: OMC's mode-continuation state carries a protection class per skill — none/light/medium/heavy with maxReinforcements 3/5/10 and stale TTLs 5/15/30 min — plus session-scoped state, a 2-hour global staleness TTL, terminal-phase sets (complete/failed/cancelled), and a nesting guard (a child skill must not overwrite the parent's active state). They note the read-check-write race is tolerated because a session is single-threaded.

Why it works: continuation enforcement without a reinforcement budget is an infinite-block generator. The class-based cap is what makes "don't stop" safe to enforce.

Fit: our W502 stop-gate continuation enforcer landed without (as far as the lift record shows) a reinforcement budget. Add: max reinforcements per activation class, stale TTL on the activation state, and terminal-phase short-circuit. Reuses the existing state shape. Effort: trivial-to-moderate.

### 1.8 W497 amendments from their session-end wiring

What: two micro-mechanisms. (a) OMC marks SessionEnd hooks `"async": true` so a 30 s session-summary job never blocks teardown. (b) Their session-end shim reads stdin with a reduced 1 s timeout (payload is small) to save ~4 s against the hook timeout.

Fit: our W497 session-end learnings ask + session-end.ts. If the learnings harvest is slow, async marks it fire-and-forget; the reduced stdin wait is free latency. Effort: trivial.

## 2. Red flags

What a `skill-security-review` would have to scrutinize, in priority order. Baseline posture: do not install; if ever, pin an exact ref and treat every row below as a review gate.

1. Distribution identity split. Brand `oh-my-claudecode` vs npm package `oh-my-claude-sisyphus` vs plugin marketplace route. Three names, two install chains, real typosquat surface (installing by brand name grabs whatever squatting package exists). Their own README flags the mismatch — verify provenance (repository URL in package.json, publish history) before trusting either route.
2. Silent auto-update. OMC ships a `silentAutoUpdate` behavior that installs unverified npm versions at runtime; only `disableAutoUpdate` (or strict mode) turns it off. A plugin that can replace its own hook code without review is a standing code-injection channel. If installed: pin + disable, full stop.
3. Shell-executed hook surface. 21 hooks run `.mjs` via `node` with shell semantics on every lifecycle event; the repo is 5,000+ commits with near-daily releases. The trusted-computing base is enormous and churns fast (master 4.15.2 vs npm 5.5.0 observed the same day). Every hook file would need reading, not sampling: pre-tool-enforcer.mjs alone is ~65 KB — an un-auditable monolith by our 1500-line law.
4. Native dependencies. `better-sqlite3` (via `prebuild-install`, which downloads prebuilt binaries at install — and is itself the deprecated-warning source they document) and `@ast-grep/napi`. Install-time binary fetch = trust in upstream build infrastructure, flagged by our supply-chain rules.
5. Auto-approve headless workers. Codex workers launch with `--dangerously-bypass-approvals-and-sandbox`, Gemini `--approval-mode yolo`, Grok `--always-approve` — their SECURITY.md equates all three to `--dangerously-skip-permissions`. The trusted-binary-path allowlist is ADVISORY (logs a warning); only /tmp-style locations are hard-rejected. External-worker features are dangerous by default.
6. Prompt-content egress. The OpenClaw bridge forwards `{{prompt}}` (raw user prompt) to an external gateway on the keyword-detector event when configured; the Jev judgment engine egresses to an external API under `TYPESAFE_API_KEY`; stop-callbacks push session summaries to Telegram/Discord/Slack with bot tokens stored in config; gateway configs embed bearer tokens. "Local by default" is true only until one of these is switched on — and the switches are single config lines.
7. Cloned-repo injection by design. Project-scope skills `.omc/skills/` take PRIORITY over user-scope skills, OMC also reads `.claude/skills/` and `.agents/skills/` from the workspace, and Claude Code auto-loads `.mcp.json`. Cloning an untrusted repo therefore loads its prompts, skills, and MCP servers. Their SECURITY.md says it plainly: clone only trusted sources. Our equivalent rule for ourselves: cloned-repo skills never enter the fleet harness; sandboxes stay deny-by-default.
8. Natural-language mode triggers. "don't stop", "must complete", "until done", "build me" activate persistent execution modes from the prompt text. Briefs and mission text flowing through a fleet WILL eventually contain these phrases; a misfire flips a session into a block-Stop loop. OMC disables keyword detection inside workers (`OMC_TEAM_WORKER`) — if W503 keyword fan-out ever grows triggers, it must inherit that same worker-disable rule.
9. Environment leakage to workers/MCP. Their own guidance: minimize env secrets because MCP processes inherit them; team workers get an env allowlist, but "no security boundary between agents" is listed as a structural limitation. Directly relevant to us: per-lane `bksk_` keys are the right pattern and must never be replaced by shared env.
10. Ecosystem threat context. Public npm campaigns specifically backdooring Claude Code sessions via hijacked SessionStart hooks have been documented (Snyk currently lists no known vulnerabilities for this package — absence of CVEs is not absence of risk for a fast-moving prompt-injection surface).
11. Unverifiable marketing numbers. "30-50% token savings", "3-5x faster shipping" appear on the site/README with no published methodology; the site itself is internally inconsistent (19 agents on the page, "32 agents registered" in its own setup output). Treat all performance claims as unmeasured.

## 3. Worse than what we have (stop wondering)

| OMC approach                                                                                                                               | Our equivalent                                                                                              | Why ours wins                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Coordination = JSON files under `.omc/state/`, mailbox on local FS, admitted TOCTOU races patched with file locks                          | governor.db work graph (transactional take/done), coord WS bus, process-backed lane liveness + 10-min grace | Their own docs show races and lock retrofitting; ours was transactional from birth                                           |
| Model routing = static agent-to-tier map + `ANTHROPIC_DEFAULT_*` env vars; no gateway, no fallback, no cost telemetry                      | routing-policy.yaml ladder through buckle → litellm → MLX swarm + z.ai; per-provider caps (W504)            | They have a lookup table; we have an operator-owned, routed, capped system                                                   |
| verify-deliverables hook: advisory, and since their regression #3209 it SUPPRESSES ALL OUTPUT — it checks and tells no one                 | `work done --sha` evidence in the graph                                                                     | A checker that cannot report is decoration; ours is load-bearing                                                             |
| Team worktree mode: opt-in, maturing, installs AGENTS.md into worker worktrees with backup/restore, cleanup has destructive escape hatches | dedicated worktree lanes + paired-lane locks + `.fleet/` briefs outside the tree                            | We do not mutate the worker's instruction files; their dirty-worktree preservation rule is good but their surface is younger |
| tmux everywhere: team workers, rate-limit wait daemon, session detection                                                                   | launchd-supervised dispatch + probe-sidecar watchdog (W494.3)                                               | Workers that "die when done" with a tmux dependency vs supervised lanes with outside-process verdicts                        |
| Advisory nudges on nearly every tool call (reminder enforcer, todo status on every hook)                                                   | gates that act, stay silent otherwise                                                                       | Context burn and nudge fatigue are the failure mode we explicitly avoid                                                      |
| Smart-model savings claims, unbenchmarked                                                                                                  | benchmarks decision-grade only; release-note proofs live separately                                         | Their numbers cannot choose between alternatives; ours must                                                                  |
| Keyword fan-out via magic words including accidental phrases                                                                               | W503 (deliberate, scoped)                                                                                   | Already lifted; OMC's variant is broader and misfire-prone                                                                   |
| Stop-gate continuation ("the boulder never stops")                                                                                         | W502                                                                                                        | Already lifted; their state budgeting is the only piece left to take (see 1.7)                                               |

## 4. If we ever touch it anyway

Checklist, in order: pin the exact commit/ref; run `skill-security-review` on THAT ref; verify the npm-vs-repo provenance for whichever route; `disableAutoUpdate`; deny project-scope `.omc/skills/` and `.mcp.json` from any cloned repo; never enable OpenClaw/Jev/stop-callbacks on fleet machines; never launch external-provider workers outside a sandbox; per-lane keys only, never shared env. The default answer stays: do not install — lift mechanisms into our own reviewed TypeScript instead.

## Source index

- Repo: github.com/Yeachan-Heo/oh-my-claudecode (master, 2026-10-07): README.md, SECURITY.md, docs/HOOKS.md, docs/ARCHITECTURE.md, docs/DELEGATION-ENFORCER.md, docs/TEAM-WORKTREE-MODE.md, docs/OPENCLAW-ROUTING.md, docs/PERFORMANCE-MONITORING.md (timed out — not read), hooks/hooks.json, scripts/{context-guard-stop,workflow-drift-guard,pre-tool-enforcer,verify-deliverables,post-tool-use-failure,session-end}.mjs, templates/deliverables.json, package.json
- npm: oh-my-claude-sisyphus (Snyk: no known vulnerabilities, retrieved 2026-10-07)
- Site: ohmyclaudecode.com (marketing; promotes marketplace route; claim inconsistencies noted in 2.11)
