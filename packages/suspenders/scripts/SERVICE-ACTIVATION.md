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


This is a bounded receipt fence, not an operating-system write sandbox or an
atomic lock across arbitrary programs. W427 bypassed shell target inspection
using `bun -e` and `fs.copyFileSync`; the subsequent supported loader would now
refuse its changed unit. An arbitrary filesystem write can still alter the disk
unit, and direct launchctl calls bypass this loader. The shell containment gate
does not interpret JavaScript filesystem calls. Preventing those writes requires
the shared lifecycle/lease enforcement work, rather than another installer.

The existing receipt also does not establish an immutable Buckle code payload.
An approved pinned worktree remains writable. Immutable gateway publication and
eliminating races with arbitrary concurrent receipt/unit writers remain separate
work; this boundary does not claim either guarantee.
