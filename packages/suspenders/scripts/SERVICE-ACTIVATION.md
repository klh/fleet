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

## Re-bless verb — correcting stale manifest intent (W640)

A receipt recorded before the last harness sync carries a stale
manifestSha256; the render fence then refuses every render into LaunchAgents
("activation refused: candidate differs from explicit approved service
intent"). The supported recovery is the owner-gated re-bless verb:

    ./install.sh --re-bless-activation --confirm <manifest-sha-prefix>

A run without --confirm dry-renders via `install-services.ts --out` (never
stdout — banner bytes would shift the sha), prints the old-receipt-intent vs
candidate diff and names the sha to confirm; nothing is written until BOTH
the intent flag and a >=12-hex prefix of the NEW candidate manifest sha are
present. The candidate sha is read from the ACTIVE GENERATION's
services.yaml and must hash-equal the repo copy (they hash-equal only right
after a sync). Units and launchd state are never touched; the write goes
through service-drift `writeActivation` only, retaining prior intent for
labels absent from the candidate render. Generation-pinned receipts are
refused (those belong to the reviewed gateway upgrade path). A successful
install --with-launchd afterwards rewrites the receipt wholesale.

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

## Re-bless after a manifest change (W639)

The receipt freezes approved argv per service plus the manifest digest, so any
`deploy/services.yaml` change (W631 stable-path renders, W638 auto-install
entry) refuses every launchd registration until the owner re-blesses:
rendering is not approval. The re-bless surface is
`scripts/record-service-activation.ts`:

    bun packages/suspenders/scripts/record-service-activation.ts --approve-stable \
      --repo <pinned checkout>/packages/suspenders

It refuses unless the pinned checkout's manifest is byte-identical to the
activated generation's (sync the harness first), refuses generation-pinned
entries (the `upgradeGateway` review flow above owns those), renders the exact
units `registerLaunchd` will render (same substitution values, machine port
overrides included), and publishes the receipt only — no launchd state is
touched. `install.sh --with-launchd` from the pinned checkout then applies the
blessed definitions, load-verifies them, and republishes what launchd actually
loaded.
