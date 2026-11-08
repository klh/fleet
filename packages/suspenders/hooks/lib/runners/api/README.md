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
