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
replace an existing approved entry. Changed upgrades or recovery units are intentionally refused pending an explicit
reviewed activation path. The existing `writeActivation` function publishes
receipts, but there is currently no supported pre-activation upgrade verb that
verifies and publishes a changed candidate. The renderer and loader never adopt
the bytes they happen to find on disk.

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
