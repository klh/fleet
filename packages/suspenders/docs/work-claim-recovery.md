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
