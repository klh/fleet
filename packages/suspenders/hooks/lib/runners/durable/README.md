# Local Pi Durable foundation

Pinned runtime: pi-durable, pi-ai and Chord 1.5.0. Durable is experimental.
This module provides persistent local jobs; Fleet's controller owns remote
admission, credentials, lifecycle supervision and sandbox launch.

`openDurableJob` requires an existing root directory, a validated job spec,
host-owned models/tool registry and a mandatory `authorize(action, spec)`
callback. The callback must enforce real rights and the current lease token;
agent input cannot supply it. Actions are open, read, submit, resume, abort
and execute. Generation is the immutable admission identity; a rotating
controller lease epoch belongs in the authorization closure, not the manifest.

The handle exposes submit, read, resume, abort and host-cleanup close.
Submission handles expose id, wait(signal), status and abort with fresh rights
checks. Cancelling a wait detaches that reader and leaves the job running.
Repeated request IDs recover the original admitted submission across reopen.

Every tool boundary checks execute rights. Model requests use a fenced fetch
at actual HTTP dispatch; throwing from a Durable provider hook is advisory
and is insufficient. This adapter accepts only the HTTP OpenAI-compatible
Buckle route. SDK internal retries are disabled; Durable owns retry policy.
Image/classifier transports and WebSockets require separate approved adapters.
The controller must also abort in-flight work and revoke credentials when a
lease is lost; pre-dispatch checks cannot stop a request already admitted.

Job storage is private POSIX storage with fsync JSONL and a 0600 manifest.
Seed/policy/runtime/model/owner identity cannot change silently on reopen.
The host must verify the seed digest against its immutable deployment image;
this library does not prove that a caller-supplied hash matches executable code.
The registry is copied per open: new jobs see updates, active jobs retain code.

The host holds a SQLite write transaction on a separate private lock file.
The OS releases it on crash without PID cleanup. Use a local filesystem
with SQLite locking support, private per-runner volumes, and Fleet's
distributed fencing. Stop any earlier port-lock runner before opening
the same job directory with this version.
