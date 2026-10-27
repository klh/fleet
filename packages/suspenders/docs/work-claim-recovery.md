# Reclaimed completion contexts

`work take` transfers a surviving dispatch context together with the claim. It
verifies the registered Git worktree, project, released claim token, original
owner receipt and baseline ancestry. The original baseline and launch time survive.
Failed transactions restore the original context bytes.

A current owner can reconcile an interrupted transfer using its current token
and exact `work show --json` `updated_at` revision:

```text
work take <id> --as <current-owner> --token <current-token> --expect-updated-at <revision>
```

If the original token receipt was never recorded, automatic reconciliation
refuses. The local operator may explicitly attest reviewed historical evidence:

```text
work take <id> --as <current-owner> --token <current-token> --expect-updated-at <revision> --reconcile-context --force --evidence <0600-json>
```

This uses the same OS-trusted operator boundary as forced operator reclaim.
A SID is not authentication. The attestation and stop receipt must be regular
0600 files, not symlinks, and at most 64 KiB. The JSON fields are `project`,
`item`, `tree`, `owner`, `revision`, `contextHash` (SHA256 of exact stale context
bytes), `productSha` (full commit merged in main and the item tree),
`originalClaimEventId`, `stopReceipt` (file path), `stopReceiptHash`, and
`attestation` with the exact value
`reviewed-original-baseline-and-merged-product-without-original-token-receipt`.

The original event must name the stale context owner and predate its launch and
the current claim. The product must descend from the original baseline and carry
a product diff. The transaction records `work.context-reconciled` with evidence
digests and actor `operator-reconcile`; raw tokens are never recorded. This does
not bypass `work done` checks or close the item. The current owner completes it
normally after reconciliation.

If the current token is lost, first use guarded operator reclaim to return the
stopped claim to READY. Then use the explicit attested command without `--token`,
pinning the new READY revision and the intended new owner in the evidence. This
path requires an unowned READY row, validates the same historical evidence and
mints a new token. It cannot override another active claim. Capture the new token
from the ordinary take result, then run `work done` normally.

## Restore a graph row that already has an immutable completion

An explicit local operator can repair a historically reactivated CLAIMED/RUNNING
row without completing the work a second time:

```text
work reconcile-completion <id> --force --expect-owner <sid> --expect-updated-at <revision> --evidence <0600-json>
```

The regular, non-symlink evidence file (0600, at most 64 KiB) contains `project`,
`item`, `owner`, `revision`, `tree`, `head`, `productSha`, `completionHash`, and
`attestation: "restore-verified-immutable-completion-without-new-work"`.
`completionHash` is SHA256 of `JSON.stringify` applied to the exact `completion`
object returned by `work show <id> --json`; `productSha` is its `commit_sha`.
`head` is the current item worktree HEAD. Both the product and HEAD must be
published ancestors of `origin/main`. The original immutable receipt remains
byte-for-byte unchanged.

The command refuses changed claims, attached or uncertain native processes,
unpublished commits and tracked/untracked product edits. Only untracked
`node_modules` and `.klh-brief.md` are treated as infrastructure. The atomic
repair records `work.completion-reconciled` with evidence digests, restores DONE,
and clears ownership. It emits no second `work.done`, revokes no keys and never
removes a worktree. Missing immutable completions use ordinary claim recovery
and completion instead. As with forced reclaim, authority is the OS-trusted
operator CLI; a supplied SID is not authentication.
