---
name: plan
description: Use when a spec exists and work must be broken into small verifiable tasks with acceptance criteria and dependency ordering — before implementation starts. Not for multi-session plans (use writing-plans) or for parallelizing live work (use `work split` on the graph).
---

Read the existing spec first; use the writing-plans skill for multi-session plans.

Read the existing spec (SPEC.md or equivalent) and the relevant codebase sections. Then:

1. Enter plan mode — read only, no code changes
2. Identify the dependency graph between components
3. Slice work vertically (one complete path per task, not horizontal layers)
4. Write tasks with acceptance criteria and verification steps
5. Add checkpoints between phases
6. Present the plan for human review

Save the plan to tasks/plan.md and task list to tasks/todo.md.

## Gotchas

- In fleet repos the work graph is the ONE ledger — a plan that mints work must land as `work add` items, never a parallel Markdown todo ledger.
- A brief/title that names a mission but no detail mints an UNFILLED item — fill descriptions at creation or the item strands its lane.
- Plan rows must be decision-grade: a task that does not choose between alternatives is prose, not a task.
