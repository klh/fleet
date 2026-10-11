# Governed gateway registration

The active Buckle unit is guarded at both supported boundaries: rendering into
the user's LaunchAgents directory and `load-launchd.sh`. The candidate's bytes
and arguments must match the existing private `service-activation.json` receipt,
in the same launchd domain, against the activated harness manifest. A mismatch
refuses before a renderer write or loader bootout. Rendering to stdout or a
staging directory remains read-only inspection and does not authorize activation.

The canonical `registerLaunchd` step passes `--owner-initial-install`. This
explicit initial-install mode only permits an unregistered gateway when there
is no approved service entry and absolute launchctl inspection confirms the exact
job is absent. General inspection errors remain a refusal. The mode cannot
replace an existing approved entry. The explicit canonical upgrade path is:

1. Publish committed reviewed code with `install.ts --step syncHarness --yes`.
   The existing publisher archives Buckle and bundles its entire import graph
   into the checksummed generation. It never runs the gateway.
2. Run `install.ts --step upgradeGateway --yes` to stage a private proposal.
   This observes the loaded job twice and changes no active unit or receipt.
3. Review the proposal, then run the returned `--step upgradeGateway
   --gateway-review <review-sha256> --yes` command. The approval digest covers
   the candidate, previous unit and receipt bytes, generation integrity, and
   loaded argv/PID birth. A changed process, including a healthy replacement
   PID, requires preparation and review again.

Activation uses `writeActivation` and the existing fenced `load-launchd.sh`.
Only the code entry moves into the real generation path. Existing working
directory, environment, database and key paths remain unchanged. A failed
loader leaves approved intent visible for observation and explicit owner
recovery; it does not silently adopt another unit or restart other services.
The source generation is content-verified, not an OS privilege boundary:
user-owned files can be changed, and such changes invalidate integrity.

## Approval fence — serialization among supported writers

As of W576.7.2 the approval boundary additionally holds an expiry-bounded
approval fence (`scripts/lib/approval-fence.ts`) around the whole reviewed
upgrade: both the receipt/unit publish and the bootout/bootstrap lifecycle
action present the same live unexpired lease. Two competing supported
upgrades cannot both commit from one prior snapshot; the second sees the
held fence and refuses (typed, unit and receipt untouched). Owner identity
is PID + process birth (the W576.3 launch-fencing authority). Proven-dead,
recycled-PID and expired owners are stale-broken by renaming the fence
record aside (auditable, never deleted); unreadable owners and corrupt
records are typed refusals, never takeovers. Interruption recovery is
bounded: a crashed holder's lease expires, and recovery re-prepares from
the published receipt — truthful intent, never blind rollback. Initial
install (`--owner-initial-install`) bypasses the fence; every other
buckle-spoke lifecycle action requires it.


This is a bounded receipt fence, not an operating-system write sandbox or an
atomic lock across arbitrary programs. W427 bypassed shell target inspection
using `bun -e` and `fs.copyFileSync`; the subsequent supported loader would now
refuse its changed unit. An arbitrary filesystem write can still alter the disk
unit, and direct launchctl calls bypass this loader. The shell containment gate
does not interpret JavaScript filesystem calls. Preventing those writes requires
the shared lifecycle/lease enforcement work, rather than another installer.

The existing receipt also does not establish an immutable Buckle code payload.
An approved pinned worktree remains writable. Immutable gateway publication
remains separate work. Races among supported writers are now fenced (see the
approval fence section above); races with arbitrary filesystem writers remain
outside this boundary, so this boundary does not claim either guarantee.
