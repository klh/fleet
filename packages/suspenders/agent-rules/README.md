# agent-rules — the role library suspenders launches agents with

One source of truth for ROLE RULES. When suspenders launches an agent it
selects the role file matching the work and rides its content into the lane
brief — referenced, never copied (central-configs law: a rule changed once
here reaches every lane).

## Files

`agent.base.rules.md` is the shared contract EVERY role extends. Role files
carry only their deltas — identity, why, role-specific rules, skills,
exit. No repetition: a rule lives in exactly one file.

| File                  | Role                             | Selected when                                                       |
| --------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `agent.base.rules.md` | shared base                      | injected FIRST for every launch                                     |
| `supervisor.rules.md` | Coordinator / supervisor session | session rides the supervisor default, refill ticks, wave management |
| `governor.rules.md`   | The fenced Suspenders controller | controller cycles: dispatch admission, reclaim, holds               |
| `reviewer.rules.md`   | Review lanes (`work.review`)     | exact-diff review, second-opinion, verdict receipts                 |
| `code.agent.md`       | Implementation lanes             | default for any claim that writes product code                      |
| `test.agent.md`       | Test migration / authoring lanes | items tagged `playwright-only`, test DRY, ratchet waves             |
| `component.agent.md`  | UI lanes                         | board / dashboard / board-html / design-token work                  |
| `deploy.agent.md`     | Hub & deploy lanes               | `hubctl`, compose, launchd, health probes, secrets                  |
| `doc.agent.md`        | Docs & knowledge lanes           | docs consolidation, knowledge roll, llms.txt sync                   |

## Selection

Dispatch maps item tags and titles to a role (`--role <name>` overrides).
No match → `code.agent.md`. Injection order: `agent.base.rules.md`, then
the role file, then the item brief — the item's MISSION/WHY/COMPLETENESS
stays authoritative (brief wins over role, role wins over base, base wins
over habit).

## Skills guarantee

Every launched agent can rely on the installed fleet skills catalog
(`skills/` — `npx skills add klh/fleet`). Role files name the skills a role
should load FIRST; agents never re-derive what a skill already encodes.

## Wiring

- Brief composer (`dispatch-next.ts`) injects the selected file verbatim.
- `install.sh` syncs this directory to the installed prefix with the rest
  of the harness; per-lane 0600 settings stay untouched.
- Law-guard: the dispatch tests pin that an unknown role name fails loudly
  and that every file here parses as markdown with a title + role line.
