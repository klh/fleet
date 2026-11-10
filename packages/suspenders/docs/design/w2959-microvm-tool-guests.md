# W2959 MicroVM tool guests

Fleet starts one Pi Durable supervisor under the existing runner lease.
The supervisor owns the journal and model connection. It starts a tool
guest only when an operation needs one. Model credentials, host
privileges, and hypervisor control stay outside the guest.

The Desktop leaf starts its container before opening the durable job
and checks that container during recovery. The Xeon leaf must open and
recover the job independently of guest availability. Reuse the control
store, lease fence, and model credential manager.

## First operation

Start with a read-only inspection profile. Host admission resolves the
approved backend, kernel, root disk, limits and seed digests. A bounded
guest channel provides explicit readiness and argv execution. The guest
gets no NIC, model key or host filesystem mount.

- Starting a supervisor creates no guest.
- The first inspection boots one guest and runs argv as UID 1000.
- Wrong digests, missing readiness or a denied profile fail before tool
  output is accepted. Stop and delete any partial launch.
- A separate lease cannot read or control the guest.

## Recovery and acceptance

Fence the guest generation as well as the supervisor lease. Coding
guests get a host-owned workspace lease. Inspection guests get a
read-only revision. Test profile switching, then kill a guest during a
call. A replacement must recover the workspace and reject late output
from the old generation. Persist intent before effects and outcome
afterward. Retry only known-safe operations.

Separately kill and reopen the supervisor on the same persisted
submission. Verify lease fencing, credential revocation and renewal,
and cleanup of all owned guests on abort. Prove the sequence on the
approved Xeon backend before promotion. W2975's offline QEMU smoke
disk powers off after readiness and only proves payload boot. Azure
activation still requires the separate APIM/Buckle exit check.
