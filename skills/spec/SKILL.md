---
name: spec
description: Use when starting a project, feature, or significant change with NO spec yet — structured SPEC.md before code. Not once a spec exists (plan takes over), and not for single edits.
---

Invoke the spec-driven-development skill.

Begin by understanding what the user wants to build. Ask clarifying questions about:

1. The objective and target users
2. Core features and acceptance criteria
3. Tech stack preferences and constraints
4. Known boundaries (what to always do, ask first about, and never do)

Then generate a structured spec covering the core areas: objective, commands, project structure, code style, testing strategy, and boundaries.

Save the spec as SPEC.md in the project root and confirm with the user before proceeding.

## Gotchas

- Specs are architecture: decisions land in docs/DECISIONS or ADRs, execution state lands on the work graph — a spec never becomes a second ledger.
- Enterprise-bound specs pick the tier by bypassability: pack + overlays + keys, never a base fork.
- Verified-only preseed + metered aids + coord write-back is THE knowledge architecture — a spec that assumes an always-on knowledge oracle contradicts landed decisions.
