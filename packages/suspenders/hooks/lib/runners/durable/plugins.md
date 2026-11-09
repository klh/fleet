# Pi package inventory for Fleet Durable

Snapshot: [pi-agent-packages.json](pi-agent-packages.json) contains all 2,968 distinct results across the 60 pages of the [Pi catalog `name=agent` search](https://pi.dev/packages?name=agent), collected 2026-11-09. It is a catalog snapshot, not a dependency or an install manifest. Each entry records its catalog page, name, description, download count, update time, type, npm URL and repository URL when available. Counts and descriptions are catalog claims; verify a package's current source, license, pinned version and behavior before enabling it. This query does not cover the entire Pi catalog.

Fleet already owns distributed admission, work state, lease fencing, credentials, model policy and runner supervision. Its [Durable adapter](README.md) supplies local persistent jobs; [runner-ctl](../api/README.md) supplies the control feed. Pi extensions may improve the agent process, but must not become a second authority for those responsibilities.

## Usable candidates

| Package | Use in Fleet | Decision and validation |
| --- | --- | --- |
| [pi-otel](https://github.com/nikiforovall/pi-otel) | Pi lifecycle, model, token, cost and tool spans via OTLP | **Pilot first.** Configure metadata-only capture and an internal collector. Its documented `propagateToShell` is off by default; test it where child processes need context. Check whether Pi model HTTP calls carry W3C `traceparent`; the extension's spans alone do not prove end-to-end propagation. |
| [pi-permission-modes](https://github.com/wynainfo/pi-permission-modes) | Agent-visible allow/ask/deny modes and OS sandbox UX | **Pilot in a disposable runner.** Test macOS and Linux file, network, child-process and restart denial. Fleet's host sandbox and credential broker remain authoritative. |
| [pi-mcp-extension](https://github.com/irahardianto/pi-mcp-extension) | Pi access to approved MCP servers | **Conditional pilot.** Only if runner profiles need MCP. Server allowlists, identity, scope and credentials must come from the host and remain outside the agent-writable workspace. |
| [pi-coding-agent-test](https://github.com/alexshpunt/pi-coding-agent-test) | Real Pi RPC/PTY integration tests | **Compatibility probe.** Its README documents Pi 0.99.1 coverage and a renderer adapter tied to Pi internals; verify with Fleet's pinned Pi before use. |

## Design references; do not install as Fleet controllers

| Package | Idea to evaluate | Overlap or constraint |
| --- | --- | --- |
| [pi-durable-subagents](https://github.com/purboo/pi-durable-subagents) | Crash/stream fault injection, stable request identity, same-session recovery | Its orchestration and recovery owner would compete with Fleet's controller and Pi Durable adapter. |
| [pi-owed](https://github.com/purboo/pi-owed) | Content-keyed evidence freshness, review and merge receipts, explicit waivers | Own task ledger and driver; depends on pi-durable-subagents. Port the acceptance checks into Fleet's existing gates if missing. |
| [@xian0x5a/pi-durable-subagents](https://github.com/xian0x5a/pi-durable-subagents) | Outstanding human-request recovery and agent switcher | Owner/spawner supervision and model policy overlap coord and Buckle. |
| [@quintinshaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) | Workflow UI and model/cost accounting | Own dispatch, routing and worktrees overlap Fleet. |
| [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) | Detached read-only investigations and completion notifications | Own background registry and child process lifecycle overlap runner-ctl. |
| [pi-goal-list-loop-audit](https://github.com/DraconDev/pi-goal-list-loop-audit) | Independent completion audit and interruption recovery | Own goal queue overlaps work; AGPL-3.0 license needs review before code reuse. |

## Avoid as configured by default

- [Langfuse's Pi plugin](https://github.com/langfuse/pi-observability-plugin) captures prompt, response, reasoning, tool payload and image content and defaults to a cloud endpoint. Fleet needs an internal endpoint and explicit content policy before using it. Prefer `pi-otel`'s metadata-only mode for the first trace pilot.
- [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) automatically learns from sessions. Fleet already has a knowledge sink; private project/classification boundaries need proof before any auto-ingestion.

## Cross-host telemetry requirement

The goal is one Jaeger-style trace from user request through Pi, runner-ctl, Fleet controller, Buckle spoke/hub, Belt and the model leg, even when hops run on different machines. The [shared telemetry package](../../../../../telemetry/README.md) already defines HTTP trace contracts; Buckle already accepts `traceparent` and emits OTLP request spans. Pi Durable and runner-ctl need the corresponding parent/child spans and propagation checked end to end.

Pilot acceptance:

1. Carry W3C `traceparent` through every internal HTTP hop and child process that performs work. Preserve one trace ID; give each hop its own span ID and parent. Propagate only bounded context across trust boundaries.
2. Export OTLP from every host to an internal collector. Label spans with service, host, run/request ID, lane, model, outcome, retry and lease epoch where safe. Include latency and token/cost measurements; mark unknown values as unknown.
3. Keep prompt, response, tool arguments, secrets and provider bodies out of default spans. Add content capture only behind explicit policy and access control.
4. Force a cross-host retry, a model fallback, a tool call and a lease revocation. In the trace UI, verify the causal path, fan-out, errors and timestamps. Check missing/duplicate spans and collector outage behavior.
5. Correlate trace IDs with existing Buckle receipts and runner NDJSON events so operators can move from a run ID to a trace without searching private content.

The first implementation experiment is `pi-otel` on one isolated Pi runner. Do not declare full distributed tracing complete until the model HTTP path and all network hops preserve context and the trace appears in the internal collector.
