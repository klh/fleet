# Checkpointed managed Claude restart

Updating subscribers does not replace code already loaded by a managed lane
driver. Use the installed runtime's canonical restart operation after the lane
has reached a verified pause boundary.

The operation preserves the existing Fleet SID, claim token, lane key, worktree,
checkpoint, native conversation UUID, routing preferences and user settings.
It refreshes only Fleet-owned hook commands and the lane's existing resolved
native effort pin. Original settings remain intact; refreshed settings and the
restart journal are private files in the lane's `.fleet` directory.

## Procedure

1. Hold new dispatch through the normal operator controls. Request a canonical
   pause, then verify actual PAUSED, a real ancestor checkpoint/capsule, native
   result boundary and no scoped inference. A queued pause is insufficient.
2. Preview with the **new installed generation**:

   ```sh
   bun "$HOME/.claude/hooks/suspenders/bin/claude-runtime.ts" restart --sid "$SID" --fleet "$REPO"
   ```

3. Add `--apply` to retire the verified old wrapper through its existing
   graceful signal handler, wait for both old processes to exit, and launch the
   new driver with `claude --resume <same-native-uuid>`. No fork, claim release,
   key replacement or new inference is performed during paused bootstrap.
4. `started` means the new wrapper is waiting PAUSED. It does **not** prove
   native continuation or message delivery. Resume through `coord resume`,
   then send a bounded direct message requiring a tool action and canonical
   acknowledgement. Verify the result:

   ```sh
   bun "$HOME/.claude/hooks/suspenders/bin/claude-runtime.ts" restart-verify --sid "$SID" --fleet "$REPO"
   ```

Verification requires the exact new process incarnation, persisted native UUID,
actual interrupt/injection, subsequent tool use, canonical RUNNING claim and
accepted direct NOTE. A live wrapper or queued event is insufficient.

## Refusals and recovery

Changed ownership, stale tokens, missing/forged checkpoints, changed edits,
unknown/reused PIDs, invalid keys, active inference or missing current hook
targets refuse retirement. Dirty work is preserved when its exact fingerprint
remains unchanged throughout the checkpointed operation.

The private journal reserves retirement and launch before their effects.
Uncertain `retiring` or `starting` phases refuse retries: reconcile the recorded
incarnation before attempting another launch. Never remove the journal, revoke
the lane key or reclaim its work to conceal an uncertain restart.

A durably `retired` operation can be retried through the same command. It uses
the original snapshot and its pinned driver/settings generation, rechecks all
authority and drain proofs, and requires both recorded processes to be absent.
Claude may append at most two bounded, same-conversation `last-prompt` and
`cost-state` bookkeeping records while shutting down. The prior transcript
prefix must remain byte-exact; messages, unknown fields, partial records and
foreign conversation IDs are refused. The journal records the verified final
transcript hash and byte count before starting the replacement. Uncertain
`starting` operations still require explicit reconciliation and never relaunch.
