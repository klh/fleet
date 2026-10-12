# Monorepo cutover record — W422.3 (2026-10-05, closed 2026-10-07)

The nine-repo era ended 2026-10-05: `klh/fleet` is the one living
repository, every package a subtree under `packages/*`, old origins
frozen read-only. This is the decision record for item W422.3.

## The merge

`git subtree add --prefix packages/<name>` per package — history
preserved, no rewrite:

| package | subtree add | from old tip |
| --- | --- | --- |
| buckle | `734e95d` | `9e73b06` |
| belt | `b76e9f6` | `7a6e9cf` |
| speedy | `6b07113` | `6d14164` |
| local | `38d7f41` | `51d2204` |
| suspenders | `1cf80ae` | `66562db` — LAST, per plan (owns deploy/ + hooks/) |
| blam | `e00dd61` | `0f9a655` — rider, W422.14 |

## History preserved

Every old tip is a merge parent of its subtree-add commit and an
ancestor of `main` (verified 2026-10-07: `git merge-base --is-ancestor`
×5 OK). Pre-cutover history stays reachable — e.g. `git log
packages/belt` spans the full 56-commit belt history.

## Old origins frozen read-only

All nine GitHub originals archived (`gh repo view <repo> --json
isArchived` → true): suspenders, belt, buckle, local, speedy, blam,
suspenders-remote, belt-remote, buckle-remote. `klh/fleet` is not
archived. Archive = push-refused at origin; local checkouts remain on
disk only as inert mirrors (install re-anchored to fleet, W422.6).

## Law

One repo, one version: every commit lands in THIS repo at
`packages/<name>/*`; the old repos never receive another commit.
