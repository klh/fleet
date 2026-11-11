# Desktop runner service

W2880 owns the installable runner-ctl composition. W2879 supplies the reviewed
authenticated listener; W2869.3 supplies the desktop tool sandbox and durable
adapter. Build the host seam without editing the peer's runtime files.

## Boundaries

- Opt-in central runner configuration. Private, bounded profile and secret
  files; separate control and executor credentials; no admin fallback in CLI.
- One trusted host process and private state directory. The first pilot does
  not advertise cross-host leases or failover. Bind HTTP to loopback.
- Pin exact profile, policy, seed and image. Old jobs keep their versions.
- Reopen only the same verified container workspace or a verified checkpoint;
  missing tmpfs requires recovery. Journals alone do not restore tool files.
- Host shutdown closes intake and journals. Reader detach never stops jobs.
- Keep NAS out of the overnight path. Deploy hub code through pinned git-pulled
  volumes; do not mount host source as hub code.

## Execution and evidence

1. Test private host configuration and persistent store opening with real
   scratch files: reject links, foreign ownership and unsafe modes.
2. Compose the guarded listener with an injected runtime, scoped identity and
   persisted epoch bindings. Prove reopen and fail-closed startup over HTTP.
3. Integrate the exact reviewed desktop adapter. Verify real tool stdin,
   nonroot/no-network execution, bounded tmpfs export and key revocation.
4. Add opt-in install and an independent probe of the installed endpoint.
   Keep existing model traffic and approval gates intact.
5. Record source and installed revisions, actual health and real job outcomes.
   Use paired BLAM receipts for performance; no promotion from a fixture.

Run `coord runner health --json` from a separate process with the configured
runner credential. This checks authenticated access to the job store and
returns only the control readiness result. The desktop acceptance run also
needs an actual model submission, tool result and credential revocation.

The standard launchd install and its activation receipt omit the runner.
To stage its unit from a reviewed installation, render
`install-services.ts --target darwin --service runner-control --out <staging>`
with the approved installed prefix. Verify that the unit targets the
installed `bin/runner-control.ts` before registering it. Keep keys in private
files and use the independent health command after activation.

Run `bun <prefix>/bin/runner-control.ts --check` on the desktop host before
activation. It validates the private inputs, checks mint authority through
Buckle identity, and inspects the pinned image in the local Docker Desktop
cache. It uses read-only probes.

## Serving capabilities

The production runner discovers selected profile models through the configured
Buckle's authenticated `/v1/models` face. The separate mint credential needs
`buckle:admin:WRITE_` for per-run keys and `buckle:proxy:READ_` for catalog access.
Neither the user control credential nor a guest receives that mint authority.

Every selected model must advertise `context_length`, `max_output_tokens`,
`reasoning` and `capability_source`. Missing, incomplete, duplicate or malformed
selected rows refuse startup and preflight; unrelated catalog rows may omit
capabilities. Values come from the serving configuration, including its fallback
routes. The runner does not substitute guessed limits or add a total token cap.
Preflight reports the selected metadata and its provenance. An operator pin
does not prove a provider's maximum model context.

Catalog discovery is bounded and refuses redirects. Permission errors refuse
startup rather than retrying with another credential or exposing response bodies.
Preflight validates discovery without submitting model work or starting a guest.
It still does not prove a completed model/tool turn or workspace recovery.
