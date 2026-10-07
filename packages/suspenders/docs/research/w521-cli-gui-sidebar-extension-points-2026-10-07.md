# W521 — CLI GUI surfaces: sidebar extension points (2026-10-07)

**Question.** Can the fleet show lanes + tasks as a sidebar INSIDE the agent
CLIs (Claude Code, Codex CLI, Copilot CLI)?

**Verdict.** Only Claude Code ships user-extensible always-visible UI:
`statusLine` (script-out), `subagentStatusLine`, `footerLinksRegexes`. Codex
CLI and Copilot CLI expose lifecycle hooks but no UI extension points.
Claude Code desktop's Browser pane hosts any URL — the belt board rides there
today with zero build. A true third-party sidebar exists only in VS Code (our
own extension).

## Extension-point table

| Host | Surface | Extensible? | Mechanism / limits | Evidence |
| --- | --- | --- | --- | --- |
| Claude Code CLI | statusLine (bottom bar) | **YES** | shell script; session JSON on stdin; multi-line rows; ANSI color; OSC 8 links; `refreshInterval` ≥1 s timer + event triggers (300 ms debounce); `COLUMNS`/`LINES` env; plugin-shippable | code.claude.com/docs/en/statusline |
| Claude Code CLI | subagentStatusLine (agent-panel rows) | **YES** — in-session subagents only | script-out; stdin = visible subagent rows (id/name/status/model/tokenCount/cwd…); emit `{"id","content"}` per row; plugin-shippable | same page, "Subagent status lines" |
| Claude Code CLI | footerLinksRegexes | **YES** — regex → clickable badge | link appears when an ID shows up in conversation | statusline page + settings-reference |
| Claude Code CLI | chat pane / sidebar | no | not extensible | — |
| Claude Code VS Code ext | Activity-bar sessions sidebar + draggable panel | no third-party contribution documented | repositioning + tabs are user prefs, not APIs | code.claude.com/docs/en/vs-code |
| Claude Code desktop | sessions sidebar (filter/group/split) | no API documented | in-session tasks pane shows subagents/background shells/workflows for the CURRENT session only | code.claude.com/docs/en/desktop |
| Claude Code desktop | Browser pane | **YES de-facto** — any URL | Cmd+Shift+B; tabbed browser beside chat; open external sites | same page, "Browse external sites" |
| Codex CLI (Rust TUI) | TUI (slash commands, themes, status) | no UI extension documented | lifecycle hooks in config docs = process events, not UI; config.toml shared CLI/IDE/app; theme control discussed upstream | .research/codex @ b741e480e203 (cli-surface-survey §2); openai/codex#1618 |
| Codex IDE extension | VS Code panel | no UI API documented | same config serves CLI/extension/app | developers.openai.com (search-verified) |
| Copilot CLI | terminal interactive | no UI extension documented | hooks system (policy / repo `.github/hooks/*.json` / `~/.copilot/hooks` / plugin-contributed) = command hooks, not UI | docs.github.com/copilot/reference/hooks-reference (survey §3) |
| Any (terminal-level) | tmux / iTerm2 pane | YES | multiplexer-side; outside the CLIs | — |

## Recommendation (ranked)

1. **Ship now — extend the existing statusline.sh.** Add `refreshInterval: 10`
   plus a second line fed by belt board reads (`GET /api/executors`,
   `GET /api/tasks?project=fleet` — docs/board-api.md); OSC 8-link each item to
   its `#task=<id>` deep link on belt.local. We already aggregate
   /tmp/agent-progress (progress.ts); this widens one-line-per-turn to live
   lanes + tasks. Covers every Claude Code session fleet-wide.
2. **Desktop today — pin belt.local in the Browser pane** as the
   sidebar-equivalent. Zero build, docs-verified.
3. **If a real sidebar is required — build our own VS Code extension** (tree
   view over the board API). The only sanctioned third-party sidebar among the
   surveyed hosts; CLI-agnostic (works with codex/copilot running in the
   integrated terminal). New package, real effort — gate on demand.
4. **Don't build:** Codex/Copilot UI hacks — no supported surface; hooks are
   lifecycle-only. Revisit if upstream ships statusline/sidebar APIs.

## Claimism notes

- Claude Code claims verified against official docs fetched 2026-10-07
  (code.claude.com).
- Codex/Copilot "no UI extension point" = absence-of-evidence vs official
  docs/hook references as of 2026-10-07; the source checkouts behind
  cli-surface-survey.md (§2–3) corroborate hook (not UI) capability. GitHub
  fetch was permission-denied in this lane — fresh source pull not re-run.
- Complements cli-surface-survey.md: that doc owns hook/adapter capability,
  this doc owns UI surfaces.

Sources: code.claude.com/docs/en/statusline · /vs-code · /desktop ·
docs.github.com/copilot/reference/hooks-reference · github.com/openai/codex
(#1618) · packages/suspenders/docs/board-api.md
