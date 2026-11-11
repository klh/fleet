# Desktop workspace handoff

Implementation contract for W2990.2.1, extending the existing runner controller
and official Pi Durable HOST runtime. W2990.2.4 owns the bounded USTAR codec.

## Current boundary

Source `702f54d0` has checked Docker cancellation, pending-start joins, terminal
stop intent and persistence-failure rollback: 57 combined tests passed. The
opaque checkpoint store publishes integrity-bound manifests last with fsync.
Capture, authorized restore and an installed HOST image remain unverified.
The full desktop wiring witness still fails graceful close and reattachment
because close destroys the workspace. Keep that continuity assertion.

## Park

1. Authorize the existing abort permission. Persist a per-run operation ID,
   phase and captured epoch with compare-and-swap; close new work intake.
2. Close the harness and quiesce the executor, joining both. SDK close keeps
   interrupted tasks pending in the HOST journal. Require final daemon-backed
   quiescence before capture.
3. Capture through the shared codec. Bind actual job manifest, immutable spec,
   image, original deadline, captured epoch and conversation ID. A published
   candidate archive alone is not resumable.
4. Stop the captured watchdog before intentional fencing. Revoke only the
   captured lease and confirm that epoch's key is dead; checked-stop its guest.
5. Commit parked state and checkpoint pointer only after all receipts succeed.
   Uncertainty retains a pending/failed transition and requires checked cleanup.

Keep capture lease renewal bounded. Submit, execute, admit, park and resume
must honor the persisted operation claim; an in-memory lock is insufficient.

## Resume

1. Authorize resume and claim one persisted restore operation. Verify trusted
   checkpoint identity and original deadline before allocating executable work.
2. Confirm old-key death before minting. Re-admit through the existing lease
   API; require a strictly newer epoch, not exactly old plus one: revocation
   and admission each advance the epoch.
3. Restore into a fresh owned guest through an explicit restore API. Never
   clear terminal stop intent or use ordinary ensure-running as restore.
4. Reopen the same HOST journal dormant; verify manifest and conversation ID.
   Bind the new epoch's credential. Harness open reconciles; resume schedules.
5. Commit new execution identity before scheduling and held-input delivery.
   Preserve held submission request IDs for deduplication.

Each opened job captures its epoch. Its authorizer, credential facade, abort
callback and watchdog cannot borrow a later token or select a later key through
a mutable map. Ensuring a new key does not revoke earlier epochs' keys.

The first restore stays on the same HOST and durable root: the manifest binds
hostname. Cross-host migration needs a separate contract. Journals, model URLs
and model credentials remain outside guests.

## Shutdown and crash recovery

Graceful HOST close stops admission and uses the same checked park operation.
Cold jobs without a workspace need a distinct shutdown path. Await and report
all cleanup failures. Interrupted phases complete verified cleanup or refuse;
they cannot enter ordinary same-epoch reattachment by guessing lifecycle state.

## Acceptance

- Real writer stops; park seals workspace and journal, kills old key and removes
  guest before reporting parked. Resume preserves bytes, manifest, conversation,
  original deadline and held request IDs with fresh authority.
- Residue, malformed archive, expired deadline, identity mismatch and capture
  failure never publish resumable state. Failed old-key revocation prevents mint.
- Concurrent park/resume/abort/admit has one durable winner; stale completion
  cannot overwrite it. Crash after each phase cleans up or refuses.
- Old closures/callbacks cannot borrow or revoke a new epoch. Missing in-memory
  jobs cannot report successful resume.
- Restore/persistence failure removes the new guest, retains its cleanup identity
  for retry and preserves the immutable checkpoint. Shutdown reports failures.

Publish HOST supervisor and downstream derivative only after these pass, with
immutable receipts. Remote/H100/APIM activation and canonical BLAM patch scoring
remain separate acceptance steps.
