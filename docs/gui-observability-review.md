# Fleet GUI and observability review

Reviewed against local runtime and monorepo source on 2026-10-06.

## Surfaces and jobs

| Surface                                        | Operator's job                                      | Evidence                                                                                     |
| ---------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Fleet Board: Decisions, Tasks, Lanes, Activity | Unblock work, inspect progress and coordinate       | Work graph, session registry, decision lifecycle, event feed                                 |
| Fleet Board: Governor                          | Understand contention and repeated failures         | Claims, bounded lane history, recovery incidents, consult outcomes                           |
| Belt dashboard                                 | Understand model availability and routing           | Network observations, registry, independent supervisor snapshots, route logs                 |
| Local service bar                              | Understand registered targets and front-door wiring | Configured target checks, Caddy TCP reachability, registration process and fragment presence |
| Service consoles                               | Inspect and recover individual services             | External probes plus recovery map, fresh supervisor evidence for intentional idle            |
| Usage                                          | Explore activity by actor, time and model           | Usage rollups; these are activity counters, not a verified invoice                           |
| Console settings                               | Review and apply runtime policy                     | Runtime policy files and existing preview/apply flow                                         |
| Buckle                                         | Authenticated key and gateway operations            | Admin API; no separate operator GUI was found                                                |

## Corrected findings

1. **False remote health:** the local bar ignored a registration's upstream and probed its coincident local port. The NAS registration therefore inherited the local board's success. It now probes the registered remote target.
2. **Reachability presented as health:** any HTTP response passed the bar's check. It now distinguishes unreachable, reachable with a failed check, and a successful configured 2xx check. Redirects cannot silently hide a failed target. Caddy TCP availability, mDNS claim-process liveness and route-fragment presence are separate observations.
3. **Intentional idle presented as failure:** Belt and the service consoles marked unloaded on-demand models down. Fresh external supervisor evidence can establish IDLE; missing, stale, alerted or blocked evidence cannot. Idle rows offer no restart instructions.
4. **Invisible recovery state:** Belt did not consume its supervisor feed. The offline Lit panel now exposes restart budgets, scheduled retries, dependency blocks and snapshot age. The Governor exposes the last 24 hours of incidents and consult feedback through a bounded read-only `/api/recovery` projection.
5. **Historical noise overwhelmed current work:** Governor painted every old lane plus duplicate zombie facts. It now prioritizes recent lanes, collapses older history into 50-row pages, scopes claims and summaries by project and bounds completions to 30. Closed lanes do not inherit old zombie colouring. Completion candidates are selected by update time before truncation, so lexical work IDs cannot hide new results.
6. **Filter unavailable until another screen was opened:** projects now populate from the first board snapshot. Project changes update the overview immediately.
7. **Navigation silently changed destinations:** background cross-origin probes could replace dashboard links with archived repository links. Navigation now stays stable; documentation links point to the monorepo.
8. **Fragmented rendering:** the local bar now uses vendored Lit and shared theme tokens/settings. Both service consoles use the existing Lit recovery rows; visible rows re-probe even after a previous UP observation. The board header and tabs wrap on narrow screens.
9. **Source preview could not start:** local swarm registry loading now supports both the installed harness and the monorepo package layout.

The new views keep last-good snapshots visibly labelled when refresh fails. Consult answers remain candidates until outcome confirmation; a quiet old incident is labelled inactive/unconfirmed rather than resolved. These interfaces do not grant leases or decide remediation automatically.

## Architecture alignment

The interface should answer three questions in order: **what needs attention, what evidence supports that state, what can I do next?** A successful request to the dashboard establishes dashboard availability; it does not establish another service's health.

Keep the work ledger, service lifecycle and request trace separate. A lane may be waiting while its model is idle and its hub is healthy. Future cross-hub views should join these observations through canonical project and origin identifiers, preserving upstream/downstream provenance and authorization boundaries. The existing designs in [cross-hub project identity](cross-hub-project-identity.md) and [upstream observability architecture](upstream-observability-architecture.md) remain the basis for that work.

Every future observation should carry its source, target, observation time, expiry and scope. Stale is a statement about evidence, not a transition of the target into DOWN. Per-lane detail belongs in bounded read models and trace/log queries rather than unbounded metrics labels. Independent health sidecars remain the authoritative service-health architecture; configured homepage checks are explicitly narrower.

## Verification and remaining work

Focused projection, target-check, state-model, recovery rendering, history-bound and installer rollback tests passed: **36 tests, 218 assertions, no failures**. Real Chrome checks covered the board screens, usage/settings navigation, project filters, retained local search across refresh, Belt supervisor rendering and both service consoles. Fresh production tabs reported no browser warnings or errors. The initial Belt bundle error was caught in the browser and corrected with named offline Lit exports.

An expanded older board/flow suite returned **52 passes, nine failures and one fixture error**. Failures concern advice-output expectations, changed task fields, demo startup/guards and prompt-preview/settings contracts. These are tracked in **W477**; they are not represented as a clean full-suite result. **W478** tracks the remaining shared observation contract, explicit global-feed labelling, inventory consolidation, downstream-origin filtering and demo-actor separation in usage. The review did not exercise destructive settings application, key administration or production task dispatch.

GUI activation uses `bash packages/suspenders/install.sh --refresh-dashboards`, a fixed code-only manifest with rollback on validation failure. Restart only `com.belt.dashboard`, `com.klh-local.dashboard` and `com.suspenders.board`. It does not run registration, key, routing or model setup.
