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

## Completed follow-through (W477, W478)

All three dashboards now use the same observation contract: source, target, scope, observation time and expiry. Cached evidence expires on screen without converting the target to DOWN. Recovery actions require current evidence. Global LLM telemetry is labelled explicitly.

Governor and Activity offer separate origin-hub and immediate-downstream filters. Remote-only lanes remain read-only observations; they do not fabricate local sessions, claims or tasks. Remote-only projects appear in the initial project selector. Expired observations return to unknown provenance.

The board relays fresh observations automatically when configured. A→B→C preserves origin A and records immediate peer B at C. Bounded ancestry prevents loops; monotonic ingest rejects older evidence. The relay limits concurrency, request duration, batch size and storage, rotates batches fairly, drains healthy backlogs between scheduled ticks, and backs off failing peers. Pending counts and retry times accompany disabled/error/success status. Remote targets require HTTPS; configuration and token files require mode 0600. Ingest uses the existing host and write-token guards. This is an operator-trusted observation feed, not cryptographic origin attestation or cross-hub project rekeying.

Configure each participating board using `~/.config/klh/observation-relays.json` (or `SUSPENDERS_OBSERVATION_RELAYS`):

```json
{
  "localHub": "hub-a",
  "targets": [
    {
      "url": "https://hub-b.example.invalid",
      "hubId": "hub-b",
      "writeTokenFile": "/absolute/private/path/hub-b-write-token"
    }
  ]
}
```

Use the receiving board's write token in that private file. No runtime peer configuration was invented during this change; the local relay reports disabled until configured.

Belt, service consoles and the local bar share the model inventory and configured probe paths, including Kev's `/v1/models`. Operator registry values remain authoritative. Usage excludes explicitly synthetic sessions by default, provides an opt-in synthetic view and handles retained legacy seed rows only after an exact canonical seed comparison. Real or ambiguous sessions override demo classification; actor-scoped reports do not inherit global anonymous traffic.

## Verification

The completed follow-through passes **165 tests with 1,062 assertions across 25 files**. Quality checks and the offline UI build pass. The dashboard refresh validated all three installed entrypoints and activated 51 code files. Chrome verified the installed Board, Belt, local bar and Usage; the 390px board has no horizontal overflow, Kev reports ready, two synthetic actors are excluded by default, and fresh tabs have no browser errors.

Focused projection, target-check, state-model, recovery rendering, history-bound and installer rollback tests passed: **36 tests, 218 assertions, no failures**. Real Chrome checks covered the board screens, usage/settings navigation, project filters, retained local search across refresh, Belt supervisor rendering and both service consoles. Fresh production tabs reported no browser warnings or errors. The initial Belt bundle error was caught in the browser and corrected with named offline Lit exports.

The older board/flow failures were repaired with isolated ephemeral-port fixtures, correctly owned child processes, current advice/task contracts, and offline prompt dependencies. Follow-through verification also covers authenticated observation ingest, three-hop forwarding, loop prevention, fair relay batching, expired evidence, model inventory and synthetic usage separation. Independent review caught and corrected supervisor evidence rejuvenation and relay capacity starvation. Live browser checks caught and corrected Kev's probe path, orphaned legacy demo attribution, launchd's missing process-tool PATH and a 390px navigation overflow. The review did not exercise destructive settings application, key administration or production task dispatch.

GUI activation uses `bash packages/suspenders/install.sh --refresh-dashboards`, a fixed code-only manifest with rollback on validation failure. Restart only `com.belt.dashboard`, `com.klh-local.dashboard` and `com.suspenders.board`. It does not run registration, key, routing or model setup.

## Destructive-surface verification (W492)

Verified against an isolated deployment on 2026-10-07: the same board and buckle entrypoints booted with a dedicated `HOME` (own `governor.db`, write token, board settings, routing policy and `buckle.db`), the board on `127.0.0.1:7797` and buckle on `127.0.0.1:7798`. No production board was touched: the LLM probe URL was pinned to a dead port and buckle ran with no upstreams, so every payload stayed on this machine. The buckle root key was minted on-device (0600, never printed).

Destructive settings application was exercised end to end in real headless Chrome: `/console/settings` → `/console/settings/belt` → preview rendered the true diff (`- num_retries: 7` / `+ num_retries: 5` against the isolated policy file) → APPLY → 303 back to the hub, and the value landed in the policy file. The guards were proven by rejection, each with the exact refusal: untrusted `Host` 403, cross-origin 403, missing token 403 ("write token required"), wrong token 403, non-boolean prompt toggle 400, unknown feature 400, and a stale preview mtime refused with the target file byte-identical afterwards. A concurrent-edit mtime guard rejects with "config changed since the preview — review the fresh diff and confirm again". Browser form posts authenticated through the HttpOnly `SameSite=Strict` write cookie — no secret ever reached JavaScript.

Key administration was exercised on the isolated buckle: mint a `bksk_` key scoped `buckle:proxy:WRITE_` (201), verify it (valid with the scope readback), ride the proxy gate with it (auth passed; the request failed 503 at the unreachable upstream, never 401), prove a non-admin key cannot mint (403), revoke, re-verify (`buckle.key_revoked`), prove the gate now refuses it (401), and read the ledger: `auth_events` issued/revoked rows and the revoked state visible through the keys readback. Missing and fake keys were refused 401. This is the API surface only — the operator GUI for keys remains unbuilt (W231, enterprise tier).

Production dispatch gating was exercised on the isolated graph: `/api/orchestrate/preview` held a `previewId` with zero work-graph writes; `/api/orchestrate/register` (write-token guarded) refused a missing token 403, an unknown project 404 and a one-child split 400; a two-child registration minted the plan and split children in the isolated graph, rendered on the board Tasks tab. One harness observation worth keeping: register accepts both raw and normalized project paths for the repo check, but the children readback matches only the raw `<repo>/.git` project identity — a caller passing the normalized path gets an empty children list while the split still lands (the UI always sends the raw label, so the rendered flow is unaffected).

Everything refused that should be refused; everything destructive sat behind confirmed intent — preview, diff, mtime guard, write token/host/origin guard, scoped revocable keys, audited lifecycle. No new defects in the three surfaces. Residual debt: the key-administration GUI (W231) and the enterprise overlay flags (`fleet-enterprise` hub profiles declare `auth.required`/`oidc.enforced`/`admin.gui`, whose code surface today is these base-code paths) remain future work in the private tier.
