# Final workspace patch capture

`DesktopLeaf.captureFinalWorkspacePatch({runId, actor, patch})` is a HOST-only
operation using the existing abort/park authorization. It closes the official
Pi Durable journal, proves daemon-backed quiescence, and persists the existing
validated workspace checkpoint before generating a patch or stopping the guest.
The request is not a model tool, HTTP configuration, or new environment knob.

The operator supplies `base.commit`, a private USTAR `base.archivePath`, and its
SHA256. The archive contains the repository files at its root. The receipt says
`sourceBinding: operator-supplied`: verifying archive bytes does not independently
prove that the named commit produced them. `repositoryPath` selects the matching
repository within the captured `/workspace` archive (for example `src`).

Prepare a Git base from the trusted public repository with immutable object
reads (`git --no-replace-objects archive --format=tar <commit>^{tree}`). A TREE
archive omits Git's commit-level PAX global header. Record the original commit,
tree, original archive SHA256 and prepared archive SHA256; compare every regular
entry's path, mode and file SHA256 against the original archive before use.
The prepared private0600 file must pass `verifyPatchBase`. This preparation does
not run candidate code or read candidate `.git`. Runtime does not normalize PAX
archives, and the strict checkpoint validator remains unchanged.

Both archives are validated and copied from the same verified nofollow file
descriptors. Copies are hashed again before a read-only bind into a fresh,
digest-pinned helper. All Git operations run there with network disabled,
UID1000, read-only root, dropped capabilities, no new privileges, and explicit
CPU/memory/PID limits. HOST never runs candidate code or Git against candidate
metadata. Candidate `.git` files/directories are excluded at every depth.
The helper creates its own index from the base, overrides conversion attributes,
force-stages candidate files (including ignored/untracked additions), and emits
a full-index binary diff. It does not use candidate `HEAD` or replay journal argv.

The operation retains the original deadline and captured run/lease epoch.
Ownership is rechecked before effects and receipt publication. The receipt binds
base SHA/commit, repository path, complete checkpoint/job/conversation/image,
source CID, helper identity, raw patch SHA256 and byte count. Patch bytes are
private and fsynced. A UUID label and exact helper CID govern checked removal;
uncertain cleanup retains the private directory and fails without a receipt.

Only after the helper is removed and patch receipt is durable does existing
handoff logic fence/revoke old authority and stop the source guest. The API
returns `patchPath`, `sha256`, and the bound receipt after successful parking.
The archive and patch survive guest removal. No benchmark grade, provider
inference, cross-HOST recovery, publication, or activation follows from this API.
