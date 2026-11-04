# W2687 — suspenders/W2293 merge resolution record (2026-11-04)

Item: W2687 "rebase suspenders/W2293 onto main (merge ladder conflict)".
Lane: autow2687-p98b319584008df14. Merge commit: 6bb24406 on
`suspenders/W2687` (pushed to origin).

## Context

The merge ladder could not land `suspenders/W2293`: its review-context
`git merge-tree` run reported a content conflict against current main
(fleet-loop NEED_DECISION, branch preserved). W2293 is the
`parked/W2255.2` lineage — the one-use main publication attestation
(`fleet-main-publish-attestation.json`) — merged onto an older main.

## Resolution

Merged `refs/heads/suspenders/W2293` (e86e4c3d) into `suspenders/W2687`
(be878110, current local main lineage). Four conflicts —
`.githooks/pre-commit`, `.githooks/reference-transaction` (added in
both), `hooks/lib/fleet-loop/merge-guard.ts`, `test/merge-guard.test.ts`
— every one a hunk of the W2255.2 file-attestation design.

Resolved `-s ours`: W2255.2's exact review FAILED (B1-forgeable-
attestation — a same-UID writer can mint the 0600 bearer JSON and
fast-forward main without a PASS receipt), and its DONE successor W2270
(07384f21, already on main; item text: "do not merge failed W2255.2")
replaces the whole design with one-use `publish_grants` rows in
governor.db plus the hook's independent re-derivation of review
evidence. Main's side of every conflict is the superseding store-grant
implementation; `pre-merge-commit` was byte-identical on both sides.
W2293's two post-merge repairs are already absorbed on main: the
merge-guard bypass spec's 30s `setDefaultTimeout` ceiling is present,
and the `--absolute-git-dir` attestation-path anchoring is moot with no
attestation file left.

The merge is pure topology: the merged tree is byte-identical to HEAD
(`git diff main HEAD --stat` empty), making `suspenders/W2293` an
ancestor of this branch so the ladder can land it in place of the
original.

A plain merge was attempted first and aborted by a tooling catch-22
worth recording: git writes conflict markers into
`.githooks/reference-transaction`, and the next ref update fires that
same (bun-shebang) hook, which fails to parse its own conflicted bytes
and aborts the transaction mid-merge. Recovery restored the marker
files from HEAD via `git show` redirects + `chmod 755` (the redirect
drops the exec bit). The `-s ours` strategy avoids the window entirely.

## Evidence

- Touched suite, run in this lane's transcript after the merge:
  `bun test test/merge-guard.test.ts` — 20 pass / 0 fail (covers the
  direct-merge bypass, guarded-publish, and the W2680 generated-asset
  exemption specs on main's side).
- First push attempt refused by the pre-push verb-contract gate on the
  documented `subscribe-attach` spawn-timing flake at load 14.3 with
  115 bun processes; retried at load <10 per the known procedure and
  the fullgate passed clean (189 pass / 0 fail, scrub clean,
  gen-openapi current, P1 contract holds). Branch pushed to origin.

## Empty evidence window note

The lane-context baseline (be878110) equals pre-merge HEAD and equals
current local main (`git rev-list --count HEAD..main` = 0), so the
merge introduced zero content change by construction and the
lesson.ancestry-merge-done-gate self-service out (merge local main for
the product window) is itself a no-op. The baseline→sha window holds
only this record. Precedent: W494/W725/W975 (lesson.done-record-not-
product) and W2688 — the decision record is the deliverable for
closure-of-landed-work items.
