# Claude coordination delivery

New local Fleet Claude lanes use `hooks/bin/claude-runtime.ts`, declared
by the Claude executor adapter. Both dispatch paths fence the runtime's
PID and birth identity; the native Claude executable is passed separately
in the lane environment. The runtime owns Claude's stream-json stdin.
On a directed event it requests a native interrupt, waits for both the
success response and the interrupted turn's result, then injects the
event into that same Claude conversation. Native stdout and delivery
receipts remain NDJSON. A protocol failure leaves the durable event queued.

This applies to newly launched local managed lanes. An existing unmanaged
interactive CLI cannot be adopted or interrupted through this runtime.
Cross-hub delivery was not covered by the probes below.

## Native hook fallback

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
`next`. Installation and hook configuration loading are separate from the
worktree probes above.

## Managed runtime verification

The managed probes used the actual installed coord CLI, store server and
subscriber, with the new runtime from its worktree and a real Claude CLI.
Both addressed notes reached `ACCEPTED` through the agent's explicit
per-event acknowledgment in the isolated durable store.

| Active work | Observed result |
| --- | --- |
| Streamed 250-line response | Native interruption ended the original turn after 241 characters, at line 6. The same conversation read and acknowledged the event and handled the new instruction. |
| Executing 20 second command | Its filesystem start marker preceded the note by 681.7 ms. Native interruption ended that turn; the completion marker was absent more than 55 seconds later. The same conversation read and acknowledged the event. |

The fixture test also verifies that native process and session identities
are reused. Launch cleanup first sends SIGTERM so the managed runtime can
reap its native child, then escalates to SIGKILL after a bounded wait.

References: [Claude hooks](https://code.claude.com/docs/en/hooks),
[streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).
