# Runner control API

The runner-ctl host injects its controller, shared store, approved profiles,
identity verifier and private credential bindings into `createRunnerApi`.
The fetch handler serves `/v1/runner/runs` and the documented per-run actions.
`openRunnerListener` binds loopback only; remote TLS needs a trusted proxy.
The listener fixture proves HTTP behavior, not desktop runtime installation.

Control-user credentials need `buckle:runner:READ_` or `WRITE_`, plus
`buckle:proxy:READ_` to call the existing Buckle identity endpoint. That read
scope permits identity/model discovery; it does **not** permit model generation.
Never grant `proxy:WRITE_` merely to operate the control API. Executor generation
credentials are separate, finite-lived and host-bound to their own run/epoch.

Use `coord runner --help`. Configure `runner.*` in central settings or pass
`--url` and `--key-file` explicitly. The private credential file must be owned
by the current user, have no group/world permissions and not be a symlink.
No fallback reads an admin credential. `--ndjson` prints one JSON record per
line, ending with a completion record; diagnostics go to stderr.

Readers use a caller-generated UUID. Pages contain at most 32 events with
4096-byte payloads; replay advances only that principal's reader. Detach does
not stop a job. Submit requires a stable request ID that reaches Pi Durable's
persisted conversation. Reuse it when retrying an uncertain submission.

Attach before replay and reuse the reader ID on reconnect. Following a job
uses this read feed; the lease watchdog stays host-owned. Park follows the
controller's runtime policy; an operator request may be refused with 409.

Unexpected errors return a safe 503 and `x-runner-trace-id`. The diagnostic
sink receives only trace, phase, operation and a closed error-class vocabulary;
request headers, exception messages and provider bodies are never logged.

## Linux hub runner canary

Use a separate host identity and private local state directory for each runner.
The Linux controller talks to the host Docker daemon over
`unix:///var/run/docker.sock`. Job containers never receive that socket or
the controller's mint credential. Runner startup, execution and artifact
export use the same daemon. On macOS they use the `desktop-linux` context.

Configure `runner.control_url` as a dedicated IPv4 loopback listener and
`runner.identity_url` as the Buckle instance for this runner. Give the
controller its own mint file and use separate owner-scoped operator credentials.
Pin the local image by digest and use a host-owned seed root and profile file.
Run the installed `runner-control.ts --check` before enabling the service.
It checks the local image and mint authority without launching a job.

On Linux, the service installer renders the opt-in `suspenders-runner-control`
user unit with `--target linux --service runner-control`. Ensure the runner
account has a functioning systemd user manager and that the rendered log
directory exists before activation. Verify authenticated readiness and an
owner-visible canary from that host. For remote operator controls, use a
trusted loopback tunnel or a separately reviewed TLS proxy. Point a hub's
inventory relay at this listener only if the hub can reach that same loopback.

Before switching the release pin, record the previous generation and unit.
On failure, stop only the candidate unit and restore the previous release.
Keep the private state intact. Check the canary's lease revocation, credential
revocation and container cleanup before sharing the bed with other workloads.

From `packages/suspenders`, run `bun test/runner-linux-preflight.fixture.ts`
to reproduce the isolated Linux preflight. It uses a pinned local Bun image,
a fixture identity service and a stub for image inspection. It does not
launch a real runner job or verify a deployment on the target host.

On Synology, verify the effective permissions on the state root before
writing any key or profile. In the NAS canary, an inherited home ACL made
a newly created directory and file report mode 0777 despite a restrictive
umask. Explicitly applying mode 0700 to the empty private root before
creating children restored 0700 directories and 0600 files. The runner's
private-file checks remain in force.
