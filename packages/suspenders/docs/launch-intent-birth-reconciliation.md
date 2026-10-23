# Explicit launch identity reconciliation

Darwin launch identities use the OS boot-session UUID and the process start
time at microsecond precision. `kern.boottime` is wall-clock derived: clock
adjustments can change its microseconds without restarting a process.

Existing records containing the old wall-clock format remain **unknown**,
never dead merely because that format differs. They cannot authorize a
second launch, reclaim, or controller takeover. An absent PID still proves
death; different new-format boot sessions or process starts prove PID reuse.

For a live managed Claude lane, the local OS operator can prepare a private
evidence file and then explicitly reconcile only its durable intent birth:

```text
dispatch intent reconcile-birth --item W123 --evidence /private/proof.json
dispatch intent reconcile-birth --item W123 --evidence /private/proof.json --apply
```

The first command creates a new 0600 file and changes no records. The second
requires a regular, non-symlink 0600 file and repeats the entire proof:
current registry PID/SID/tree, original microsecond start and executable,
current claim token/context/revision, canonical PAUSED capsule and ancestor
Git checkpoint, exact native child/settings and native UUID/pause boundary.
Active, foreign, stale, or missing evidence refuses repair. The transaction
compares the original nonce, revision, PID and birth plus the current claim;
it updates one birth and appends an immutable audit event atomically.

This command trusts the local OS operator's ability to invoke the CLI. A
caller-supplied SID is not authentication. It neither changes a claim token,
worktree, checkpoint, native process nor the restart guard. Resume/restart
remains a separate guarded operation. Controller and approval-fence records
are not rewritten by this lane-only command.

Verification distinguishes deterministic migration/CAS tests from actual
read-only capture: sixteen original paused lanes retained their original
process-start suffix and passed the existing claim/native checkpoint proofs;
no production reconciliation was applied as part of that capture.
