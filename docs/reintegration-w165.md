# W165 re-integration record (W695.8.6)

`parked/W165` is fully merged into main: the branch tip `02e36228`
("W165: spoke profile — hub-capability split per the federation doc") is an
ancestor of main — verified with `git merge-base --is-ancestor` on
2026-10-19. Nothing remained to re-apply.

What main carries today (all verified on disk at main HEAD):

- `packages/suspenders/hooks/lib/profile.ts` — the shared hub/spoke
  capability grammar (spoke ships NO auth issuance / identity / key custody).
- `packages/suspenders/hooks/lib/secrets-home.ts` — lifted secretsHome, so
  the client token presenter ships on spokes.
- `packages/buckle/src/gov/federation-manifest.ts` —
  `FedManifest.capabilities`, profile-aware builder.
- `packages/suspenders/install.sh` — `--profile spoke` excludes the
  auth-issuance files and writes `capabilities.json`.
- Pins: `packages/suspenders/test/profile.test.ts`,
  `test/federation-pull.test.ts`, `packages/buckle/test/gov-federation.test.ts`.

Verification: `bun test packages/suspenders/test/profile.test.ts
packages/suspenders/test/federation-pull.test.ts
packages/buckle/test/gov-federation.test.ts` → 22 pass / 0 fail (after
`bun install --force` relink in the fresh worktree).

The parked branch is now redundant and safe to delete.
