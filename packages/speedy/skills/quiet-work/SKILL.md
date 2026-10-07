---
name: quiet-work
description: Use when the user asks agents to work quietly, report only completion or blockers, or stop showing routine progress and inline diffs.
---

# Quiet work

Do the authorized work, tests and internal review. Do not narrate routine steps,
print patches, show source excerpts, repeat tool output, or describe your thinking
unless the user asks. Keep required coordination and machine completion records.
Notify the user promptly only when their input is needed or an important failure
changes the outcome. Finish with a short, self-contained result and relevant
verification or unresolved blocker. Requested artifacts can be as long as needed.

For Claude Code, native tool cards are controlled by its renderer, not this
instruction. Enable its supported fullscreen focus view:

```bash
bun ~/.claude/skills/quiet-work/scripts/quiet-output.ts --apply
```

The helper preserves other settings, permissions, hooks, model configuration and
output styles. It changes presentation settings only. Validated against Claude
Code 2.1.283. New sessions pick up the default. For an already running fullscreen
session, `/focus` toggles its live view; check the resulting view before toggling
again. Detailed tools remain available in the transcript viewer with Ctrl+O.

For Copilot, Codex or other harnesses, apply the prose rule and their supported
presentation controls. Do not claim this helper configures their native UI.
Never replace Edit/Write with unguarded shell writes just to hide a tool card.
