# Fleet health and status contract

Application endpoints report process liveness or telemetry. Independent probe
sidecars own the hub health verdict: a responding application cannot certify
that its dependencies, deployment or network are working.

| Package / service                 | Application endpoint                                       | Meaning                                                                               |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Buckle gateway                    | `/health`, `/status`                                       | Legacy plain `ok` process liveness; status telemetry with a fresh `healthy` verdict   |
| Suspenders board                  | `/status`                                                  | Process and request telemetry; external checks observe reachability                   |
| Suspenders store                  | `/health`, `/status`                                       | Database query and instance identity; process telemetry                               |
| Suspenders knowledge API          | `/health`, `/status`                                       | Process liveness; process telemetry; unknown routes return 404                        |
| Belt dashboard                    | `/health`, `/api/status`                                   | Process liveness; aggregate observations, not a claim that every model is ready       |
| Local dashboard                   | `/health`, `/api/status`                                   | Process liveness; registry and network observations                                   |
| Belt and legacy local-LLM routers | `/health`, `/health/liveness`, legacy `/health/liveliness` | Compatible process-liveness aliases; backend/model availability is checked separately |
| Hub probe sidecars                | `/healthz`, `/status`                                      | Independent verdict: 200 only for a fresh successful probe; 502 otherwise             |
| Speedy / Blam                     | No Fleet daemon endpoint                                   | Configuration/hooks and benchmark tools; no artificial service-health route added     |

Status payloads retain their existing shapes. HTTP 200 on a telemetry endpoint
means the document was served, not that every dependency is healthy. Probe
consumers reject explicit `ok:false`, `healthy:false`, known failure status
strings, redirects, failed HTTP codes, malformed JSON and oversized JSON bodies.
Plain-text liveness remains compatible. JSON health inspection is bounded to
64 KiB; fetch deadlines include body reads. Diagnostic supervisor checks that
explicitly allow an auth response remain separate from strict health checks.

Sidecars start down before successful evidence, report degrading on a missed
sample, confirm repeated misses before the down transition, recover on success,
and refuse stale evidence. Health/status endpoints support GET and HEAD, with
empty HEAD bodies; OPTIONS advertises allowed methods and unsupported methods
return 405 after applicable access guards. Existing write/host guards can reject
unauthorized methods with 403 first. Sidecars reject unknown paths rather than
returning a healthy reply.

`hubctl status` checks independent `/healthz` ports and Docker health state.
It supports local hub profiles without SSH and bounds each network request.
Health changes invalidate cached telemetry verdicts immediately, even while
request counters retain their configured refresh interval. Callback failures
produce a false verdict instead of escaping the request handler.

## Activation and verification

Focused contract tests exercise failed initial probes, malformed/false/oversized
responses, redirect rejection, bounded rings, recovery, actual sidecar HTTP
methods, cached verdict changes, knowledge API routing and local hub status.
Belt/local tests additionally exercise real dashboard/router child processes
and backend-unavailable model discovery. Buckle tests preserve legacy health
responses and cover health callback errors and HEAD handling.

Local activation uses the Suspenders installer for hook/API code and its
code-only dashboard refresh manifest, which includes the shared health helper.
Router/supervisor code must also be upgraded when activating the Belt runtime;
existing machine configuration and model choices remain operator-owned.

The NAS was unreachable during this pass (`No route to host`). No successful
NAS endpoint check or remote deployment is claimed. Hub deployments still
require the updated git-pulled service and sidecar code; local tests do not
establish remote readiness.
