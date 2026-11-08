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
