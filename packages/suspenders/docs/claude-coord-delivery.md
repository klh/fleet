# Claude coordination delivery

The Claude hook adapter provides native wakeup and mandatory delivery at
supported hook boundaries. It does **not** cancel active model generation
or an executing tool.

`signalClaudeDirectEvent(event, sid)` in `hooks/lib/claude-wake.ts` queues
a bounded local marker for an exact addressed `NOTE`, `consult`, or
`consult.answer`. The subscriber calls it after verifying `event.target`.
Its boolean result means the marker was written; it proves neither model
delivery nor acknowledgment. Broadcasts never signal this adapter.

The `claude-wake` gate runs as a Claude-owned `asyncRewake` hook. One
filesystem watcher per session waits for a marker, emits the event as
stderr, and exits 2. Claude turns that into a native system reminder.
SessionStart, UserPromptSubmit, PostToolUse, and Stop arm or rearm the
watcher. A watcher expires after 24 hours; the next hook arms another.
`SUSPENDERS_CLAUDE_WAKE=0` disables the watcher.

The synchronous push hook has a separate delivery watermark. A pending
direct marker denies the next PreToolUse once so Claude must reconsider
that tool call, even if native wakeup was already queued. PostToolUse
delivers pending context. The Stop hook drains unaccepted direct events
before spending the work item's continuation budget. These hook emissions
never accept a durable Fleet receipt on the agent's behalf. Routine
BROADCAST lines remain in the subscriber log and durable inbox without
being injected by the push hook.

## Verified limits

Live probes on Claude Code 2.1.283 used a fresh Claude process, the
machine's configured model route, and actual hook processes. They did
not call the model gateway directly.

| Situation | Observed result |
| --- | --- |
| Idle stream-json session | An asyncRewake signal produced a new response without another user input. |
| Running 8 second Bash tool | Hook feedback appeared 15 ms after the signal; the tool continued to completion. The next model response handled the message. |
| Idle after that wake | A second signal woke the rearmed session again. |
| Active streamed generation | Hook feedback appeared 44 ms after the signal. The original response continued for 12,308 characters and completed before the queued feedback was handled. |

The installed implementation queues asyncRewake feedback with priority
`next`. Already running interactive sessions cannot gain a managed stdin
channel through this adapter. A true interrupt needs a launcher that owns
Claude's stream-json input, sends the SDK interrupt control request, and
then supplies the direct event to that same conversation. Installation and
hook configuration loading are separate from the worktree probes above.

References: [Claude hooks](https://code.claude.com/docs/en/hooks),
[streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
