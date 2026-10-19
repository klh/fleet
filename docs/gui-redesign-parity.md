# Fleet console: feature parity before visual replacement

The October 19 HTML study is a layout sketch. Its overview, work, model and
usage numbers are examples. Its Decisions, Tasks, Lanes, Activity, Governor and
Setup views mainly describe or link to the working screens. It must not become
the production console in that state.

## Working surfaces to retain

| Area | Working surface | Capability the redesign must expose |
| --- | --- | --- |
| Decisions | `suspenders.local/#decisions` | Project filter; option selection; owner ruling or lane reply; cancel; advice with leg status; manual re-evaluation and history. Never copy unusable advice into the answer. |
| Tasks | `suspenders.local/#tasks` | Table and Kanban; sorting and project/owner filters; parent and child work; dependencies; executor and reasoning effort; dispatch, reassign, unclaim, cancel, second opinion; task drawer with linked decisions, timeline, spend and completion evidence. |
| Lanes | `suspenders.local/#lanes` | Live and historical lanes, liveness, owner, claim and model route; start and failure evidence; tail and message controls; worktree and revision evidence. |
| Activity and governor | `suspenders.local/#activity` and `#governor` | Event stream, claims, policy and recovery state. Keep the project filter and the action tied to the exact event or claim. |
| Setup | `suspenders.local/#setup` | Service and hub state, project enrolment and deployment checks. Distinguish probe evidence from process state. |
| Usage | `suspenders.local/usage` | Time and team filters; actor and model breakdown; stacked timeline and hour distribution; activity and aid tables; cross-hub state; cache efficiency and request drilldown. Numeric legends and degraded hubs must be truthful. |
| Models | `belt.local` | Local and remote inventory, per-endpoint probe and served model, router state, route history and failure evidence. |
| Gateway | `suspenders.local/console/belt` | Buckle gateway controls and audit, including keys, scopes, limits and routing. Do not replace controls with a static service-status card. |
| Services | `bar.local` and `suspenders.local/console/local` | Service registry, independent health evidence and the existing service-specific controls. |
| Enterprise | Existing enterprise panels in the board | Identity, federation, audit, usage, policy and vault panels. Show rollout and configuration state separately from demonstrated production operation. |

## Release rule

Redesign the live Lit components and shared CSS tokens in place. A replacement
route is ready only when each row above has a working route to the same action
and detail, with the original view still reachable during rollout. Test the
normal, empty, loading, error and stale states in a browser. Count an action as
present only when it completes against the real API and its result appears in
the working record; a label, sample number or outbound link is not parity.

First slice: keep the current board and usage pages as the functional baseline,
remove duplicate summaries, and improve navigation and drilldown without
replacing task, decision or lane controls. The HTML study remains a visual
reference until those checks pass.
