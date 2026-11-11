# Delegated child rehearsal

W2977.2.1 carries the W2977 delegation modules through the real
Docker runner leaf. W2977.2.2 retains native Xeon verification and
depends on this rehearsal and W2959.

The Docker witness uses a pinned Alpine image, the actual runner
controller, Pi Durable journal, lease store and credential manager.
Local protocol fixtures provide the model stream and key-admin API.
Their synthetic usage is excluded from model benchmarks.

The witness checks route denial before reservation or key minting,
an approved seed read through a real guest, foreign-caller denial,
repeated admission and submission without another model request,
and cancellation during an open model stream. Cancellation revokes
the credential and fences the lease before the reservation releases.
The test waits for Docker's asynchronous container removal.

Reproduced defects repaired in this slice are timestamp-sensitive
reservation replay, brief hashes incorrectly used as seed digests,
budget consumption before entitlement validation, repeated admission
trying to acquire an already-held lease, and unfenced cancellation.
Captured-lease replay still requires the original controller, open
rights, a matching immutable spec and a current lease.

The child/control suites and existing Desktop process-loss recovery
tests passed together, 54 tests. Qlty reported no issues.
Native microVM execution and usage-backed cancellation accounting
remain required before remote promotion.
